// WebDAV 手动同步的后台逻辑测试：用内存假服务器覆盖目录创建、上传、恢复、
// 错误映射和远端文件校验。不访问真实网络。
// 运行：node tests/webdav-sync.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const urlSource = fs.readFileSync(path.join(ROOT, "url-utils.js"), "utf8");
const syncSource = fs.readFileSync(path.join(ROOT, "webdav-sync.js"), "utf8");

const BASE = "https://dav.example.com/remote.php/dav/files/me/";
const FILE = `${BASE}LaterOn/lateron-sync.json`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeResponse(status, body = "", headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized[String(name).toLowerCase()] ?? null },
    async text() { return body; }
  };
}

function makeServer() {
  const files = new Map();
  const dirs = new Set();
  const calls = [];
  const state = { failMethod: "", failStatus: 0, throwMethod: "" };

  async function fetchImpl(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method, headers: options.headers || {}, body: options.body || null });
    if (state.throwMethod === method) throw new Error("socket hang up");
    if (state.failMethod === method) return makeResponse(state.failStatus, "failed");
    if (method === "MKCOL") {
      if (dirs.has(url)) return makeResponse(405);
      dirs.add(url);
      return makeResponse(201);
    }
    if (method === "PUT") {
      files.set(url, String(options.body || ""));
      return makeResponse(201);
    }
    if (method === "GET" || method === "HEAD") {
      if (!files.has(url)) return makeResponse(404);
      const body = files.get(url);
      return makeResponse(200, method === "HEAD" ? "" : body, {
        "content-length": Buffer.byteLength(body),
        "last-modified": new Date("2026-01-02T03:04:05Z").toUTCString()
      });
    }
    return makeResponse(500);
  }

  return { files, dirs, calls, state, fetch: fetchImpl };
}

function makeEnv({ store = {}, server = makeServer() } = {}) {
  const listeners = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      getManifest: () => ({ version: "1.67.0" })
    },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : (keys == null ? Object.keys(store) : [keys]);
          const output = {};
          for (const key of list) if (key in store) output[key] = clone(store[key]);
          return output;
        },
        async set(patch) {
          Object.assign(store, clone(patch));
        }
      }
    }
  };

  const context = vm.createContext({
    chrome,
    fetch: server.fetch,
    URL,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    btoa,
    console
  });
  vm.runInContext(urlSource, context, { filename: "url-utils.js" });
  vm.runInContext(syncSource, context, { filename: "webdav-sync.js" });

  // 模拟 chrome.runtime.sendMessage：找到返回 true（异步应答）的监听器。
  function send(message) {
    return new Promise((resolve) => {
      for (const listener of listeners) {
        if (listener(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  }

  return { store, server, context, send };
}

function config(extra = {}) {
  return { url: BASE, username: "me", password: "pass", path: "LaterOn/lateron-sync.json", ...extra };
}

function item(id, url, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    description: "Summary",
    image: "",
    favicon: "",
    source: "example.com",
    projectId: null,
    url,
    savedAt: 1700000000000,
    status: "unread",
    read: false,
    doneAt: null,
    ...extra
  };
}

(async () => {
  // 1) 地址拼接：目录按段编码，文件名也编码。
  {
    const { context } = makeEnv();
    const targets = context.LaterOnWebdav.remoteTargets({
      url: BASE,
      username: "me",
      password: "pass",
      path: "A B/同步.json"
    });
    assert.strictEqual(
      targets.fileUrl,
      `${BASE}A%20B/%E5%90%8C%E6%AD%A5.json`
    );
    // vm 里的数组原型和宿主不同，转成宿主数组再比较。
    assert.deepStrictEqual(Array.from(targets.dirUrls), [`${BASE}A%20B/`]);
    assert.strictEqual(targets.auth.username, "me");
    console.log("✅ 地址与路径编码");
  }

  // 2) 测试连接：目录不存在时先 MKCOL，文件不存在也算连接成功。
  {
    const server = makeServer();
    const { send } = makeEnv({ store: { laterOnWebdav: config() }, server });
    const result = await send({ type: "WEBDAV_TEST" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.remoteExists, false);
    assert.ok(server.calls.some((call) => call.method === "MKCOL" && call.url === `${BASE}LaterOn/`));
    assert.ok(server.calls.some((call) => call.method === "HEAD" && call.url === FILE));
    console.log("✅ 测试连接：自动建目录并识别空远端");
  }

  // 3) 上传：带 Basic Auth、完整备份格式和同步状态。
  {
    const store = {
      laterOnWebdav: config(),
      laterOnItems: [item("i1", "https://example.com/one", { projectId: "p1" })],
      laterOnProjects: [{ id: "p1", name: "Project", createdAt: 1700000000000 }],
      laterOnCovers: { i1: "data:image/png;base64,AAAA" },
      laterOnOrder: { all: ["i1"], p1: ["i1"] }
    };
    const { server, send } = makeEnv({ store });
    const result = await send({ type: "WEBDAV_UPLOAD" });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.items, 1);
    assert.strictEqual(result.projects, 1);
    assert.strictEqual(result.covers, 1);
    assert.ok(result.bytes > 0);
    assert.ok(store.laterOnWebdav.lastSyncAt > 0);
    assert.strictEqual(store.laterOnWebdav.lastError, "");

    const put = server.calls.find((call) => call.method === "PUT");
    assert.ok(put, "应发起 PUT");
    assert.strictEqual(put.url, FILE);
    assert.strictEqual(put.headers.Authorization, `Basic ${Buffer.from("me:pass").toString("base64")}`);
    assert.match(put.headers["Content-Type"], /application\/json/);

    const payload = JSON.parse(put.body);
    assert.strictEqual(payload.type, "lateron-backup");
    assert.strictEqual(payload.version, 2);
    assert.strictEqual(payload.items.length, 1);
    assert.strictEqual(payload.projects[0].id, "p1");
    assert.strictEqual(payload.covers.i1, "data:image/png;base64,AAAA");
    assert.deepStrictEqual(payload.order.all, ["i1"]);
    console.log("✅ 上传：备份格式、封面、排序、认证与状态");
  }

  // 4) 恢复：过滤非法网页、重复网址、未知项目和坏封面，只保留合法引用。
  {
    const remote = {
      type: "lateron-backup",
      version: 2,
      exportedAt: 1700000000123,
      items: [
        item("i1", "https://example.com/one?utm_source=x", { projectId: "p1" }),
        item("i2", "https://example.com/one", { projectId: "p1" }),
        item("i3", "https://example.com/three", { projectId: "missing-project" }),
        item("bad", "ftp://example.com/file")
      ],
      projects: [
        { id: "p1", name: "Project", createdAt: 1700000000000 },
        { id: "bad-project", name: "" }
      ],
      covers: {
        i1: "data:image/png;base64,AAAA",
        i2: "data:image/png;base64,BBBB",
        i3: "https://example.com/not-a-cover.png"
      },
      order: {
        all: ["i1", "i3", "missing"],
        p1: ["i1", "i2"],
        "missing-project": ["i1"],
        unfiled: ["i3"]
      }
    };
    const server = makeServer();
    server.files.set(FILE, JSON.stringify(remote));
    const store = {
      laterOnWebdav: config(),
      laterOnItems: [item("local", "https://example.com/local")],
      laterOnCurrentItem: "local"
    };
    const { send } = makeEnv({ store, server });
    const result = await send({ type: "WEBDAV_RESTORE" });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.items, 2);
    assert.strictEqual(result.projects, 1);
    assert.strictEqual(result.covers, 1);
    assert.deepStrictEqual(store.laterOnItems.map((entry) => entry.id), ["i1", "i3"]);
    assert.strictEqual(store.laterOnItems[1].projectId, null, "未知项目应落回等待整理");
    assert.deepStrictEqual(Object.keys(store.laterOnCovers), ["i1"]);
    assert.deepStrictEqual(store.laterOnOrder.all, ["i1", "i3"]);
    assert.deepStrictEqual(store.laterOnOrder.p1, ["i1"]);
    assert.strictEqual(store.laterOnOrder["missing-project"], undefined);
    assert.strictEqual(store.laterOnCurrentItem, null, "当前阅读条目不存在时应清空");
    assert.ok(store.laterOnWebdav.lastRestoreAt > 0);
    console.log("✅ 恢复：校验网页、项目、封面与排序引用");
  }

  // 5) 无效远端文件不能破坏本机数据。
  {
    const server = makeServer();
    server.files.set(FILE, JSON.stringify({ hello: "world" }));
    const store = {
      laterOnWebdav: config(),
      laterOnItems: [item("local", "https://example.com/local")]
    };
    const { send } = makeEnv({ store, server });
    const result = await send({ type: "WEBDAV_RESTORE" });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "invalid-file");
    assert.strictEqual(store.laterOnItems.length, 1);
    assert.strictEqual(store.laterOnItems[0].id, "local");
    assert.ok(store.laterOnWebdav.lastError.includes("valid"));
    console.log("✅ 恢复：无效文件被拒绝且不改本机数据");
  }

  // 6) 认证失败与网络错误映射到可翻译的错误码。
  {
    const server = makeServer();
    server.state.failMethod = "PUT";
    server.state.failStatus = 401;
    const { store, send } = makeEnv({ store: { laterOnWebdav: config() }, server });
    const result = await send({ type: "WEBDAV_UPLOAD" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "auth");
    assert.strictEqual(result.status, 401);
    assert.ok(store.laterOnWebdav.lastError.includes("401"));
  }
  {
    const server = makeServer();
    server.state.throwMethod = "GET";
    const { send } = makeEnv({ store: { laterOnWebdav: config() }, server });
    const result = await send({ type: "WEBDAV_RESTORE" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "network");
  }
  console.log("✅ 错误码：认证失败与网络异常");

  // 7) 空地址 / 非法地址 / 越界路径都直接拒绝，不会发起请求。
  {
    const server = makeServer();
    const { send } = makeEnv({ store: { laterOnWebdav: config({ url: "" }) }, server });
    const result = await send({ type: "WEBDAV_TEST" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "invalid-config");
    assert.strictEqual(server.calls.length, 0);
  }
  {
    const server = makeServer();
    const { send } = makeEnv({ store: { laterOnWebdav: config({ url: "not a url" }) }, server });
    const result = await send({ type: "WEBDAV_TEST" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "invalid-url");
    assert.strictEqual(server.calls.length, 0);
  }
  {
    const server = makeServer();
    const { send } = makeEnv({ store: { laterOnWebdav: config({ path: "../escape.json" }) }, server });
    const result = await send({ type: "WEBDAV_TEST" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "invalid-path");
    assert.strictEqual(server.calls.length, 0);
  }
  console.log("✅ 配置校验：空地址、非法地址与越界路径均不发起请求");

  console.log("\nPASS WebDAV 手动同步");
})().catch((error) => {
  console.error("测试失败：", error);
  process.exit(1);
});
