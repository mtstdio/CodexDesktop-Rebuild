const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("acorn");
const {
  MAIN_MARKER,
  RENDERER_MARKER,
  patchMainEntry,
  patchRendererBundle,
} = require("./patch-session-api");

test("patchMainEntry: 主进程代码注入与幂等性验证", () => {
  const dummyMain = `
    const { app, BrowserWindow } = require("electron");
    app.whenReady().then(() => {
      new BrowserWindow();
    });
  `;

  // First patch
  const first = patchMainEntry(dummyMain);
  assert.equal(first.changed, true);
  assert.ok(first.source.includes(MAIN_MARKER));
  assert.ok(first.source.includes("CODEX_CONTROL_PORT"));
  assert.ok(first.source.includes("EADDRINUSE"));
  assert.ok(first.source.includes("control-port.json"));
  assert.ok(first.source.includes("threadGetMatch"));
  assert.ok(first.source.includes("turn_error"));
  assert.ok(first.source.includes("turn_stalled"));
  assert.ok(first.source.includes("STALL_TIMEOUT_MS"));

  // Syntax validation
  assert.doesNotThrow(() => {
    parse(first.source, { ecmaVersion: 2022, sourceType: "script" });
  });

  // Second patch (idempotency)
  const second = patchMainEntry(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("patchRendererBundle: 渲染层路由注入与幂等性验证", () => {
  const dummyRenderer = `
    export const router = {
      "unarchive-conversation": XE(async(e, { conversationId: t }) => {
        await e.unarchiveConversation(t);
      }),
      "other-route": XE(async() => {})
    };
  `;

  // First patch
  const first = patchRendererBundle(dummyRenderer);
  assert.equal(first.changed, true);
  assert.ok(first.source.includes(RENDERER_MARKER));
  assert.ok(first.source.includes("control-turn"));
  assert.ok(first.source.includes("control-interrupt"));
  assert.ok(first.source.includes("approvalPolicy:\"never\""));
  assert.ok(first.source.includes("globalThis.__codexAppServerManager"));

  // Syntax validation
  assert.doesNotThrow(() => {
    parse(first.source, { ecmaVersion: 2022, sourceType: "module" });
  });

  // Second patch (idempotency)
  const second = patchRendererBundle(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("patchRendererBundle: 未找到目标路由时优雅跳过", () => {
  const unrelatedSource = `export const empty = {};`;
  const res = patchRendererBundle(unrelatedSource);
  assert.equal(res.changed, false);
  assert.equal(res.notFound, true);
  assert.equal(res.source, unrelatedSource);
});

test("patchRendererBundle: 新版 AppServerManager 全局注册注入与幂等性验证", () => {
  const dummyAppInitial = `
    function registerAppServer(a) {
      let o = store.get(UE, a);
      if (o == null) throw Error(\`No AppServerManager registered for hostId: \${a}\`);
      let channel = new MessageChannel();
      return o;
    }
  `;

  // First patch
  const first = patchRendererBundle(dummyAppInitial);
  assert.equal(first.changed, true);
  assert.ok(first.source.includes(RENDERER_MARKER));
  assert.ok(first.source.includes("globalThis.__codexAppServerManager=o"));

  // Syntax validation
  assert.doesNotThrow(() => {
    parse(first.source, { ecmaVersion: "latest", sourceType: "module" });
  });

  // Second patch (idempotency)
  const second = patchRendererBundle(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

