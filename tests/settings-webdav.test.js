// 设置页 WebDAV 表单接线测试：加载真实的 settings.html + theme.js + i18n.js + settings.js，
// 用内存 chrome 和假同步响应覆盖配置回填、测试连接、上传、恢复和错误提示。
// 运行：NODE_PATH=<jsdom 路径> node tests/settings-webdav.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "settings.html"), "utf8");
const themeSource = fs.readFileSync(path.join(ROOT, "theme.js"), "utf8");
const i18nSource = fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8");
const settingsSource = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

const now = Date.now();
const store = {
  laterOnWebdav: {
    url: "https://dav.example.com/remote.php/dav/files/me/",
    username: "me",
    password: "secret",
    path: "LaterOn/lateron-sync.json",
    lastSyncAt: now - 3600000,
    lastRestoreAt: 0,
    lastError: "",
    lastErrorCode: "",
    lastErrorStatus: 0
  },
  laterOnItems: [
    { id: "i1", url: "https://example.com/1" },
    { id: "i2", url: "https://example.com/2" }
  ]
};
const changeListeners = [];
const sent = [];
const alerts = [];
let testResponse = { ok: true, remoteExists: true, bytes: 2048, modifiedAt: now };

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "https://lateron.test/settings.html",
  virtualConsole
});
const { window } = dom;

window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : (keys == null ? Object.keys(store) : [keys]);
        const output = {};
        for (const key of list) if (key in store) output[key] = JSON.parse(JSON.stringify(store[key]));
        return output;
      },
      async set(patch) {
        Object.assign(store, JSON.parse(JSON.stringify(patch)));
        for (const [key, value] of Object.entries(patch)) {
          for (const listener of changeListeners) listener({ [key]: { newValue: value } }, "local");
        }
      },
      async remove(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
      }
    },
    onChanged: { addListener: (listener) => changeListeners.push(listener) }
  },
  runtime: {
    getURL: (resource) => `chrome-extension://lateron/${resource}`,
    async sendMessage(message) {
      sent.push(message);
      if (message.type === "WEBDAV_TEST") return testResponse;
      if (message.type === "WEBDAV_UPLOAD") {
        return { ok: true, items: 2, projects: 1, covers: 0, bytes: 4096, at: Date.now() };
      }
      if (message.type === "WEBDAV_RESTORE") {
        return { ok: true, items: 3, projects: 1, covers: 0, at: Date.now() };
      }
      return { ok: false, code: "unknown" };
    }
  },
  commands: { async getAll() { return []; } },
  tabs: {
    async getCurrent() { return { id: 1 }; },
    async update() {},
    async create() {}
  }
};
window.LaterOnDialog = {
  async confirm() { return true; },
  async alert(input) { alerts.push(input); }
};

window.eval(themeSource);
window.eval(i18nSource);
window.eval(settingsSource);

(async () => {
  await tick(180);
  const document = window.document;
  const urlInput = document.querySelector("#webdavUrl");
  const status = document.querySelector("#webdavStatus");

  check("WebDAV 表单已渲染", !!urlInput && !!status);
  check("服务器地址从存储回填", urlInput?.value === store.laterOnWebdav.url);
  check("用户名从存储回填", document.querySelector("#webdavUser")?.value === "me");
  check("远端路径从存储回填", document.querySelector("#webdavPath")?.value === "LaterOn/lateron-sync.json");
  check("状态行显示上次上传", /上次上传/.test(status?.textContent || ""), status?.textContent);

  // 测试连接：发给后台，成功状态写回页面。
  document.querySelector("#webdavTest").click();
  await tick(150);
  check("测试连接发送 WEBDAV_TEST", sent.some((message) => message.type === "WEBDAV_TEST"));
  check("测试连接成功提示", /连接成功/.test(status?.textContent || ""), status?.textContent);

  // 上传：确认后发送，并提示上传结果。
  document.querySelector("#webdavUpload").click();
  await tick(150);
  check("上传发送 WEBDAV_UPLOAD", sent.some((message) => message.type === "WEBDAV_UPLOAD"));
  check("上传结果提示", /已上传 2 篇网页/.test(status?.textContent || ""), status?.textContent);
  check("上传完成弹窗", alerts.some((input) => /上传完成/.test(input.title)));

  // 恢复：确认后发送，清掉侧栏秒开快照，并提示恢复结果。
  window.localStorage.setItem("laterOnPanelCache", "[]");
  document.querySelector("#webdavRestore").click();
  await tick(150);
  check("恢复发送 WEBDAV_RESTORE", sent.some((message) => message.type === "WEBDAV_RESTORE"));
  check("恢复结果提示", /已恢复 3 篇网页/.test(status?.textContent || ""), status?.textContent);
  check("恢复后清掉侧栏缓存", window.localStorage.getItem("laterOnPanelCache") === null);
  check("恢复完成弹窗", alerts.some((input) => /恢复完成/.test(input.title)));

  // 错误：401 映射成认证失败提示，而不是显示 HTTP 原始信息。
  testResponse = { ok: false, code: "auth", status: 401, error: "Authentication failed (HTTP 401)" };
  document.querySelector("#webdavTest").click();
  await tick(150);
  check("认证失败显示中文提示", /认证失败/.test(status?.textContent || ""), status?.textContent);

  check("页面没有 jsdom 运行错误", errors.length === 0, errors.join(" | "));

  console.log(`\n${failures === 0 ? "🎉 全部通过" : `❌ 有 ${failures} 项没通过`}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error("测试跑挂了：", error);
  process.exit(1);
});
