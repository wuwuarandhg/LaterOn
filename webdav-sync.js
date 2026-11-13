// WebDAV 手动同步：把本机的网页、项目、排序和上传封面打包成一个 JSON，
// 由用户手动上传到自己的 WebDAV 服务器，或从远端恢复覆盖本机。
//
// 设计取舍：
//  • 手动 + 本机覆盖远端：不做双向合并，因此不需要 updatedAt / 删除墓碑；
//  • 远端是明文 JSON，格式与设置页「导出网页」的 backup v2 兼容；
//  • 网络请求放在 service worker：设置页关掉后同步仍能完成；
//  • service worker 里没有 DOMParser / XHR，所以不解析 PROPFIND 的 XML：
//    目录用 MKCOL 创建，文件是否存在用 HEAD 判断。
(function () {
  "use strict";

  const CONFIG_KEY = "laterOnWebdav";
  const ITEMS_KEY = "laterOnItems";
  const PROJECTS_KEY = "laterOnProjects";
  const COVERS_KEY = "laterOnCovers";
  const ORDER_KEY = "laterOnOrder";
  const CURRENT_ITEM_KEY = "laterOnCurrentItem";
  const DEFAULT_PATH = "LaterOn/lateron-sync.json";
  // 大文件（封面多时）至少要给到分钟级；测试连接只需几秒。
  const REQUEST_TIMEOUT_MS = 120000;
  const TEST_TIMEOUT_MS = 20000;
  const ACTIONS = new Set(["WEBDAV_TEST", "WEBDAV_UPLOAD", "WEBDAV_RESTORE"]);

  function syncError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function httpError(response, action = "Request") {
    const status = Number(response?.status) || 0;
    if (status === 401) {
      const error = syncError("auth", "Authentication failed (HTTP 401)");
      error.status = status;
      return error;
    }
    if (status === 403) {
      const error = syncError("forbidden", "Access denied (HTTP 403)");
      error.status = status;
      return error;
    }
    // WebDAV 用 409 表示父目录不存在，通常是服务器地址填错了。
    if (status === 409) {
      const error = syncError("parent-missing", "Parent folder not found (HTTP 409)");
      error.status = status;
      return error;
    }
    const error = syncError("http", `${action} failed with HTTP ${status}`);
    error.status = status;
    return error;
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      url: String(source.url || "").trim(),
      username: String(source.username || ""),
      password: String(source.password || ""),
      path: String(source.path || "").trim() || DEFAULT_PATH,
      lastSyncAt: Number(source.lastSyncAt) || 0,
      lastRestoreAt: Number(source.lastRestoreAt) || 0,
      lastError: typeof source.lastError === "string" ? source.lastError : "",
      lastErrorCode: typeof source.lastErrorCode === "string" ? source.lastErrorCode : "",
      lastErrorStatus: Number(source.lastErrorStatus) || 0,
      lastErrorAt: Number(source.lastErrorAt) || 0,
      lastUploadBytes: Number(source.lastUploadBytes) || 0,
      lastRemoteAt: Number(source.lastRemoteAt) || 0,
      lastRemoteBytes: Number(source.lastRemoteBytes) || 0
    };
  }

  // Basic Auth：凭据按 UTF-8 编码，兼容中文用户名 / 密码。
  function basicAuth(auth) {
    const username = String(auth?.username || "");
    const password = String(auth?.password || "");
    if (!username && !password) return "";
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return `Basic ${btoa(binary)}`;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function parseBase(raw) {
    const value = String(raw || "").trim();
    if (!value) throw syncError("invalid-config", "WebDAV URL is required");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw syncError("invalid-url", "Invalid WebDAV URL");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw syncError("invalid-url", "WebDAV URL must use http or https");
    }
    // 允许把账号写在 URL 里（https://user:pass@host/...），但更推荐填在单独字段；
    // 这里把凭据抽出来并从 URL 去掉，避免 fetch 自行处理 URL 凭据时的兼容性问题。
    const embedded = {
      username: url.username ? safeDecode(url.username) : "",
      password: url.password ? safeDecode(url.password) : ""
    };
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
    return { url, embedded };
  }

  function pathSegments(raw) {
    const value = String(raw || "").trim().replace(/^\/+/, "");
    if (/[?#]/.test(value)) throw syncError("invalid-path", "Remote path can’t contain ? or #");
    const parts = value.split("/").filter(Boolean);
    if (!parts.length) throw syncError("invalid-path", "Remote file path is empty");
    for (const part of parts) {
      if (part === "." || part === ".." || part.includes("\\")) {
        throw syncError("invalid-path", "Invalid remote path");
      }
    }
    return parts;
  }

  // 把「服务器根地址 + 相对路径」拆成要创建的目录和最终文件地址。
  // 目录只创建用户填写的相对路径部分，服务器地址本身假定已存在。
  function remoteTargets(config) {
    const base = parseBase(config?.url);
    const parts = pathSegments(config?.path || DEFAULT_PATH);
    const fileName = parts.pop();
    const dirs = parts;
    const baseHref = `${base.url.origin}${base.url.pathname.replace(/\/?$/, "/")}`;
    const dirUrls = dirs.map((_, index) => {
      const encoded = dirs.slice(0, index + 1).map(encodeURIComponent).join("/");
      return `${baseHref}${encoded}/`;
    });
    const fileUrl = `${baseHref}${dirs.map(encodeURIComponent).join("/")}${dirs.length ? "/" : ""}${encodeURIComponent(fileName)}`;
    return {
      dirUrls,
      fileUrl,
      auth: {
        username: String(config?.username || base.embedded.username || ""),
        password: String(config?.password || base.embedded.password || "")
      }
    };
  }

  async function davRequest(method, url, { auth, headers = {}, body = null, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    const finalHeaders = { ...headers };
    const authorization = basicAuth(auth);
    if (authorization) finalHeaders.Authorization = authorization;
    try {
      return await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        signal: controller?.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "follow"
      });
    } catch (error) {
      if (controller?.signal?.aborted || error?.name === "AbortError") {
        throw syncError("timeout", `Request timed out after ${Math.round(timeout / 1000)}s`);
      }
      throw syncError("network", String(error?.message || error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function ensureCollections(targets, timeout = REQUEST_TIMEOUT_MS) {
    for (const dirUrl of targets.dirUrls) {
      const response = await davRequest("MKCOL", dirUrl, { auth: targets.auth, timeout });
      // 201 已创建；405 已存在是 WebDAV 的常见回应；部分服务器返回 200/204/3xx。
      if ([200, 201, 204, 301, 302, 307, 308, 405].includes(response.status)) continue;
      throw httpError(response, "MKCOL");
    }
  }

  async function buildSnapshot() {
    const stored = await chrome.storage.local.get([ITEMS_KEY, PROJECTS_KEY, COVERS_KEY, ORDER_KEY]);
    let appVersion = "";
    try { appVersion = chrome.runtime.getManifest().version; } catch { /* 测试环境没有 manifest */ }
    return {
      type: "lateron-backup",
      version: 2,
      app: "LaterOn",
      appVersion,
      exportedAt: Date.now(),
      items: Array.isArray(stored[ITEMS_KEY]) ? stored[ITEMS_KEY] : [],
      projects: Array.isArray(stored[PROJECTS_KEY]) ? stored[PROJECTS_KEY] : [],
      covers: stored[COVERS_KEY] && typeof stored[COVERS_KEY] === "object" ? stored[COVERS_KEY] : {},
      order: stored[ORDER_KEY] && typeof stored[ORDER_KEY] === "object" ? stored[ORDER_KEY] : {}
    };
  }

  async function readConfig() {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    return normalizeConfig(stored[CONFIG_KEY]);
  }

  // 配置和状态共用一条串行队列：同步结束时写状态，不能把用户刚改的地址/密码覆盖掉。
  let configWriteQueue = Promise.resolve();
  function updateConfig(patch) {
    const pending = configWriteQueue.then(async () => {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      const next = { ...normalizeConfig(stored[CONFIG_KEY]), ...patch };
      await chrome.storage.local.set({ [CONFIG_KEY]: next });
      return next;
    });
    configWriteQueue = pending.catch(() => {});
    return pending;
  }

  async function testConnection(config) {
    const targets = remoteTargets(config);
    // 先尝试建目录：既能确认地址可达，也能提前暴露只读权限问题。
    await ensureCollections(targets, TEST_TIMEOUT_MS);
    let response = await davRequest("HEAD", targets.fileUrl, { auth: targets.auth, timeout: TEST_TIMEOUT_MS });
    // 少数 WebDAV 服务器不允许 HEAD，退回只读 0 字节的 GET。
    if (response.status === 405 || response.status === 501) {
      response = await davRequest("GET", targets.fileUrl, {
        auth: targets.auth,
        timeout: TEST_TIMEOUT_MS,
        headers: { Range: "bytes=0-0" }
      });
    }
    if (response.status === 401 || response.status === 403) throw httpError(response);
    if (response.status === 404) return { ok: true, remoteExists: false };
    if (!response.ok && response.status !== 206) throw httpError(response, "HEAD");
    return {
      ok: true,
      remoteExists: true,
      bytes: Number(response.headers?.get?.("content-length")) || 0,
      modifiedAt: Date.parse(response.headers?.get?.("last-modified") || "") || 0
    };
  }

  async function uploadNow(config) {
    const targets = remoteTargets(config);
    await ensureCollections(targets);
    const snapshot = await buildSnapshot();
    const body = JSON.stringify(snapshot);
    const response = await davRequest("PUT", targets.fileUrl, {
      auth: targets.auth,
      body,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
    if (!response.ok) throw httpError(response, "PUT");
    const at = Date.now();
    await updateConfig({
      lastSyncAt: at,
      lastError: "",
      lastErrorCode: "",
      lastErrorStatus: 0,
      lastErrorAt: 0,
      lastUploadBytes: body.length,
      lastRemoteAt: at
    });
    return {
      ok: true,
      at,
      bytes: body.length,
      items: snapshot.items.length,
      projects: snapshot.projects.length,
      covers: Object.keys(snapshot.covers).length
    };
  }

  function isSafeKey(key) {
    return key !== "__proto__" && key !== "constructor" && key !== "prototype";
  }

  function sanitizeAsset(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return "";
    if (text.startsWith("local://")) return text;
    if (/^data:image\//i.test(text)) return text;
    try {
      const url = new URL(text);
      return ["http:", "https:"].includes(url.protocol) ? text : "";
    } catch {
      return "";
    }
  }

  function sanitizeItem(raw, projectIds) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "");
    if (!id) return null;
    let parsedUrl;
    try {
      parsedUrl = new URL(String(raw.url || ""));
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return null;
    const status = raw.status === "done" || raw.status === "reading" || raw.status === "unread"
      ? raw.status
      : (raw.read ? "done" : "unread");
    return {
      ...raw,
      id,
      title: String(raw.title || raw.url || ""),
      description: String(raw.description || ""),
      image: sanitizeAsset(raw.image),
      favicon: sanitizeAsset(raw.favicon),
      source: String(raw.source || parsedUrl.hostname.replace(/^www\./, "")),
      projectId: projectIds.has(raw.projectId) ? raw.projectId : null,
      url: String(raw.url),
      savedAt: Number(raw.savedAt) || 0,
      status,
      read: status === "done",
      doneAt: status === "done" ? (Number(raw.doneAt) || Date.now()) : null
    };
  }

  // 远端文件可能是手工改过的，恢复前逐条校验：只接受 http(s) 网页、
  // 合法项目 id、图片协议的封面，以及引用了真实条目的排序。
  function sanitizeSnapshot(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
      throw syncError("invalid-file", "Not a valid LaterOn sync file");
    }

    const projects = [];
    const projectIds = new Set();
    for (const project of Array.isArray(raw.projects) ? raw.projects : []) {
      if (!project || typeof project !== "object") continue;
      const id = String(project.id || "");
      const name = String(project.name || "").trim();
      if (!id || !name || projectIds.has(id)) continue;
      projectIds.add(id);
      projects.push({
        ...project,
        id,
        name,
        createdAt: Number(project.createdAt) || 0,
        ...(project.pinned ? { pinned: true } : {}),
        ...(project.archived ? { archived: true } : {})
      });
    }

    const items = [];
    const itemIds = new Set();
    const knownUrls = new Set();
    const normalize = globalThis.LaterOnUrl?.normalize || ((value) => String(value || ""));
    for (const rawItem of raw.items) {
      const item = sanitizeItem(rawItem, projectIds);
      if (!item) continue;
      const urlKey = normalize(item.url);
      if (itemIds.has(item.id) || knownUrls.has(urlKey)) continue;
      itemIds.add(item.id);
      knownUrls.add(urlKey);
      items.push(item);
    }

    const covers = {};
    const rawCovers = raw.covers && typeof raw.covers === "object" ? raw.covers : {};
    for (const [id, value] of Object.entries(rawCovers)) {
      if (!isSafeKey(id) || !itemIds.has(id)) continue;
      if (typeof value !== "string" || !value.startsWith("data:image/")) continue;
      covers[id] = value;
    }

    const order = {};
    const rawOrder = raw.order && typeof raw.order === "object" ? raw.order : {};
    for (const [scope, list] of Object.entries(rawOrder)) {
      if (!isSafeKey(scope)) continue;
      if (scope !== "all" && scope !== "unfiled" && !projectIds.has(scope)) continue;
      if (!Array.isArray(list)) continue;
      const ids = [...new Set(list.filter((id) => typeof id === "string" && itemIds.has(id)))];
      if (ids.length) order[scope] = ids;
    }

    return { items, projects, covers, order };
  }

  async function restoreNow(config) {
    const targets = remoteTargets(config);
    const response = await davRequest("GET", targets.fileUrl, { auth: targets.auth });
    if (response.status === 404) throw syncError("no-file", "No sync file on the WebDAV server");
    if (!response.ok) throw httpError(response, "GET");

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw syncError("invalid-file", "Not a valid JSON file");
    }
    const snapshot = sanitizeSnapshot(parsed);
    const at = Date.now();
    await chrome.storage.local.set({
      [ITEMS_KEY]: snapshot.items,
      [PROJECTS_KEY]: snapshot.projects,
      [COVERS_KEY]: snapshot.covers,
      [ORDER_KEY]: snapshot.order
    });
    // 「正在读」指向的网页如果不存在了，清掉，避免两个视图去定位一张不存在的卡。
    const storedCurrent = await chrome.storage.local.get(CURRENT_ITEM_KEY);
    const currentId = storedCurrent[CURRENT_ITEM_KEY];
    if (currentId && !snapshot.items.some((item) => item.id === currentId)) {
      await chrome.storage.local.set({ [CURRENT_ITEM_KEY]: null });
    }
    await updateConfig({
      lastRestoreAt: at,
      lastError: "",
      lastErrorCode: "",
      lastErrorStatus: 0,
      lastErrorAt: 0,
      lastRemoteAt: at,
      lastRemoteBytes: text.length
    });
    return {
      ok: true,
      at,
      items: snapshot.items.length,
      projects: snapshot.projects.length,
      covers: Object.keys(snapshot.covers).length,
      exportedAt: Number(parsed.exportedAt) || 0
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!ACTIONS.has(message?.type)) return undefined;
    (async () => {
      let payload;
      try {
        const config = await readConfig();
        if (message.type === "WEBDAV_TEST") payload = await testConnection(config);
        else if (message.type === "WEBDAV_UPLOAD") payload = await uploadNow(config);
        else payload = await restoreNow(config);
      } catch (error) {
        payload = {
          ok: false,
          code: error?.code || "unknown",
          status: Number(error?.status) || 0,
          error: String(error?.message || error)
        };
        // 测试连接失败不写进「上次同步错误」，避免一次填错地址污染同步状态。
        if (message.type !== "WEBDAV_TEST") {
          await updateConfig({
            lastError: payload.error,
            lastErrorCode: payload.code,
            lastErrorStatus: payload.status,
            lastErrorAt: Date.now()
          }).catch(() => {});
        }
      }
      // 设置页可能在上传途中被关掉；回执失败不应该被当成同步失败。
      try {
        sendResponse(payload);
      } catch {
        // 端口已断开，忽略。
      }
    })();
    return true;
  });

  // 暴露给测试和调试；service worker 里也方便在控制台检查。
  globalThis.LaterOnWebdav = {
    normalizeConfig,
    remoteTargets,
    sanitizeSnapshot,
    testConnection,
    uploadNow,
    restoreNow
  };
})();
