#!/usr/bin/env node
/**
 * patch-session-api.js — 注入外部 HTTP 控制服务，实现控制指定会话。
 *
 * 两层架构：
 * 1. 主进程（Main Process）：
 *    在 bootstrap.js / main.js 注入自包含的 Node.js 原生 HTTP 服务：
 *    - 监听 127.0.0.1:4000（支持通过 CODEX_CONTROL_PORT 覆盖，多实例 EADDRINUSE 自动递增重试）。
 *    - 写入 ~/.codex/instances/{pid}.json 与 ~/.codex/control-port.json 便于外部发现，退出时自动清理。
 *    - POST /api/threads/:threadId/turn：通过 SSE 流式触发并监听会话执行，支持 focus 唤醒 UI。
 *    - POST /api/threads/:threadId/interrupt：中断指定会话。
 *    - GET /health：获取当前实例健康状态与端口信息。
 * 2. 渲染进程（Renderer Process）：
 *    在 webview/assets/app-main-*.js 的路由表中注入会话控制路由与 appServerManager 全局引用，
 *    确保强制以 approvalPolicy="never" 执行，实现无人值守全自主操作。
 *
 * Usage:
 *   node scripts/patch-session-api.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-session-api.js --check      # 试运行，只报告
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { locateBundles, relPath, SRC_DIR, PROJECT_ROOT } = require("./patch-util");

const MAIN_MARKER = "/* __CODEX_SESSION_CONTROL_MAIN_V1__ */";
const RENDERER_MARKER = "/* __CODEX_SESSION_CONTROL_RENDERER_V1__ */";

// ─── Layer 1: Main Process HTTP Server Injection ────────────────

const MAIN_INJECT = `${MAIN_MARKER}
(function() {
  try {
    const http = require("node:http");
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const { BrowserWindow } = require("electron");

    const BASE_PORT = parseInt(process.env.CODEX_CONTROL_PORT || "4000", 10);
    const MAX_RETRIES = 30;
    let activePort = null;
    let instanceFile = null;
    let globalPortFile = null;

    function getCodexDir() {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      try { fs.mkdirSync(home, { recursive: true }); } catch (_) {}
      return home;
    }

    const COCKPIT_INSTANCES_DIR =
      process.env.COCKPIT_INSTANCES_DIR ||
      path.join(os.homedir(), ".antigravity_cockpit", "instances");
    let registeredFiles = [];

    function registerInstance(port) {
      activePort = port;
      const userDataDir = (function() {
        try {
          const { app } = require("electron");
          if (app && app.getPath) return app.getPath("userData");
        } catch (_) {}
        const userArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
        return userArg ? userArg.split("=")[1] : null;
      })();

      const payload = JSON.stringify({
        pid: process.pid,
        port,
        userDataDir: userDataDir || null,
        startedAt: Date.now()
      }, null, 2);

      // 1. Cockpit instances 目录 (/Users/o/.antigravity_cockpit/instances)
      try {
        if (fs.existsSync(COCKPIT_INSTANCES_DIR) || fs.existsSync(path.dirname(COCKPIT_INSTANCES_DIR))) {
          fs.mkdirSync(COCKPIT_INSTANCES_DIR, { recursive: true });
          const cockpitFile = path.join(COCKPIT_INSTANCES_DIR, \`control-\${process.pid}.json\`);
          fs.writeFileSync(cockpitFile, payload, "utf8");
          registeredFiles.push(cockpitFile);
        }
      } catch (_) {}

      // 2. 实例专属 userDataDir 下写入 control.json
      if (userDataDir) {
        try {
          fs.mkdirSync(userDataDir, { recursive: true });
          const userDirFile = path.join(userDataDir, "control.json");
          fs.writeFileSync(userDirFile, payload, "utf8");
          registeredFiles.push(userDirFile);
        } catch (_) {}
      }

      // 3. ~/.codex 回退目录
      try {
        const codexDir = getCodexDir();
        const instancesDir = path.join(codexDir, "instances");
        fs.mkdirSync(instancesDir, { recursive: true });
        const codexFile = path.join(instancesDir, \`\${process.pid}.json\`);
        fs.writeFileSync(codexFile, payload, "utf8");
        registeredFiles.push(codexFile);
        const globalFile = path.join(codexDir, "control-port.json");
        fs.writeFileSync(globalFile, payload, "utf8");
        registeredFiles.push({ file: globalFile, singleCheck: true });
      } catch (_) {}
    }

    function cleanupInstance() {
      for (const item of registeredFiles) {
        try {
          if (typeof item === "string") {
            if (fs.existsSync(item)) fs.unlinkSync(item);
          } else if (item && item.singleCheck) {
            const data = JSON.parse(fs.readFileSync(item.file, "utf8"));
            if (data && data.pid === process.pid) fs.unlinkSync(item.file);
          }
        } catch (_) {}
      }
    }

    process.on("exit", cleanupInstance);
    process.on("SIGINT", () => { cleanupInstance(); process.exit(); });
    process.on("SIGTERM", () => { cleanupInstance(); process.exit(); });

    const server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

      const url = new URL(req.url, \`http://\${req.headers.host || "localhost"}\`);
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", pid: process.pid, port: activePort }));
      }

      const threadGetMatch = pathname.match(/^\\/api\\/threads\\/([^/]+)$/);
      if (req.method === "GET" && threadGetMatch) {
        const threadId = decodeURIComponent(threadGetMatch[1]);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) {
          res.writeHead(503, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Codex window not available" }));
        }
        try {
          const detail = await win.webContents.executeJavaScript(\`
            (async () => {
              if (!globalThis.__codexAppServerManager) return null;
              const readRes = await globalThis.__codexAppServerManager.sendRequest("thread/read", {
                threadId: \${JSON.stringify(threadId)},
                includeTurns: true
              }).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
              const itemsRes = await globalThis.__codexAppServerManager.sendRequest("thread/items/list", {
                threadId: \${JSON.stringify(threadId)}
              }).catch(() => null);
              return { readRes, itemsRes };
            })()
          \`);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, data: detail }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: String(e) }));
        }
      }

      const turnMatch = pathname.match(/^\\/api\\/threads\\/([^/]+)\\/turn$/);
      if (req.method === "POST" && turnMatch) {
        const threadId = decodeURIComponent(turnMatch[1]);
        let bodyStr = "";
        req.on("data", (chunk) => { bodyStr += chunk; });
        req.on("end", async () => {
          let body = {};
          try { body = JSON.parse(bodyStr || "{}"); } catch (_) {}
          const prompt = body.prompt;
          if (!prompt) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Missing required 'prompt' in request body" }));
          }

          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
          if (!win) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Codex window not available" }));
          }

          if (body.focus) {
            try { win.show(); win.focus(); } catch (_) {}
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          });
          res.write(\`data: \${JSON.stringify({ type: "turn_starting", threadId })}\\n\\n\`);

          let aborted = false;
          req.on("close", () => { aborted = true; });

          try {
            const startScript = \`
              (async () => {
                if (!globalThis.__codexAppServerManager) throw new Error("App server manager not initialized in renderer");
                return await globalThis.__codexAppServerManager.sendRequest("turn/start", {
                  threadId: \${JSON.stringify(threadId)},
                  input: [{ type: "text", text: \${JSON.stringify(prompt)} }],
                  approvalPolicy: "never"
                });
              })()
            \`;
            const startRes = await win.webContents.executeJavaScript(startScript);
            const turnId = startRes && startRes.turn ? startRes.turn.id : null;
            res.write(\`data: \${JSON.stringify({ type: "turn_started", turnId, turn: startRes && startRes.turn })}\\n\\n\`);

            let lastItemCount = 0;
            let isDone = false;
            let lastActivityTime = Date.now();
            const STALL_TIMEOUT_MS = 20000;
            let pollAttempts = 0;
            const maxPollAttempts = 600;

            while (!isDone && !aborted && pollAttempts < maxPollAttempts) {
              await new Promise((r) => setTimeout(r, 500));
              pollAttempts++;
              if (win.isDestroyed()) break;

              const pollScript = \`
                (async () => {
                  if (!globalThis.__codexAppServerManager) return null;
                  const itemsRes = await globalThis.__codexAppServerManager.sendRequest("thread/items/list", {
                    threadId: \${JSON.stringify(threadId)},
                    turnId: \${JSON.stringify(turnId || "")}
                  }).catch(() => null);
                  const readRes = await globalThis.__codexAppServerManager.sendRequest("thread/read", {
                    threadId: \${JSON.stringify(threadId)},
                    includeTurns: true
                  }).catch(() => null);
                  return { itemsRes, readRes };
                })()
              \`;
              const pollData = await win.webContents.executeJavaScript(pollScript).catch(() => null);
              if (!pollData) continue;

              const items = (pollData.itemsRes && pollData.itemsRes.items) || [];
              if (items.length > lastItemCount) {
                for (let i = lastItemCount; i < items.length; i++) {
                  res.write(\`data: \${JSON.stringify({ type: "item", item: items[i] })}\\n\\n\`);
                }
                lastItemCount = items.length;
                lastActivityTime = Date.now();
              }

              const turns = (pollData.readRes && pollData.readRes.thread && pollData.readRes.thread.turns) || [];
              const currentTurn = turns.find((t) => t.id === turnId) || (pollData.readRes && pollData.readRes.thread && pollData.readRes.thread.currentTurn);

              // 1. 显式捕获 Turn 级错误（如 429 Too Many Requests, exceeded retry limit 等）
              if (currentTurn && currentTurn.error) {
                isDone = true;
                res.write(\`data: \${JSON.stringify({
                  type: "turn_error",
                  error: currentTurn.error,
                  message: currentTurn.error.message || String(currentTurn.error),
                  turn: currentTurn
                })}\\n\\n\`);
                break;
              }

              // 2. 检查全局或 thread 级错误
              if (pollData.readRes && pollData.readRes.thread && pollData.readRes.thread.error) {
                isDone = true;
                res.write(\`data: \${JSON.stringify({
                  type: "turn_error",
                  error: pollData.readRes.thread.error,
                  message: pollData.readRes.thread.error.message || String(pollData.readRes.thread.error),
                  turn: currentTurn
                })}\\n\\n\`);
                break;
              }

              // 3. 终态完成判定
              if (currentTurn && ["completed", "failed", "cancelled", "interrupted", "error"].includes(currentTurn.status)) {
                isDone = true;
                res.write(\`data: \${JSON.stringify({ type: "turn_completed", status: currentTurn.status, turn: currentTurn })}\\n\\n\`);
                break;
              }

              // 4. 静默超时检测（超时无新 item 且无活跃状态变迁）
              if (Date.now() - lastActivityTime > STALL_TIMEOUT_MS) {
                isDone = true;
                res.write(\`data: \${JSON.stringify({
                  type: "turn_stalled",
                  message: \`Turn stalled: no output or status change for \${STALL_TIMEOUT_MS / 1000}s\`,
                  turn: currentTurn
                })}\\n\\n\`);
                break;
              }
            }

            if (!aborted) res.end();
          } catch (err) {
            if (!aborted) {
              res.write(\`data: \${JSON.stringify({ type: "error", message: String(err && err.message ? err.message : err) })}\\n\\n\`);
              res.end();
            }
          }
        });
        return;
      }

      const interruptMatch = pathname.match(/^\\/api\\/threads\\/([^/]+)\\/interrupt$/);
      if (req.method === "POST" && interruptMatch) {
        const threadId = decodeURIComponent(interruptMatch[1]);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) {
          res.writeHead(503, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Codex window not available" }));
        }
        try {
          await win.webContents.executeJavaScript(\`
            (async () => {
              if (!globalThis.__codexAppServerManager) return;
              await globalThis.__codexAppServerManager.sendRequest("turn/interrupt", {
                threadId: \${JSON.stringify(threadId)},
                turnId: ""
              }).catch(() => {});
            })()
          \`);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: String(e) }));
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    function tryListen(port, retriesLeft) {
      server.once("error", (err) => {
        if (err && err.code === "EADDRINUSE" && retriesLeft > 0) {
          tryListen(port + 1, retriesLeft - 1);
        } else {
          console.error("[codex-session-api] failed to bind server:", err ? err.message : err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        registerInstance(port);
        console.log(\`[codex-session-api] listening on http://127.0.0.1:\${port} (pid=\${process.pid})\`);
      });
    }

    tryListen(BASE_PORT, MAX_RETRIES);
  } catch (e) {
    console.error("[codex-session-api] init error:", e);
  }
})();
\n`;

function selectMainEntry(files) {
  let candidates = files.filter((file) => file === "bootstrap.js");
  if (candidates.length === 0) {
    const hashed = files.filter((file) => /^main-[^.]+\.js$/.test(file));
    candidates = hashed.length > 0 ? hashed : files.filter((file) => file === "main.js");
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveDeclaredMain(asarDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asarDir, "package.json"), "utf-8"));
    if (typeof pkg.main !== "string" || pkg.main.length === 0) return null;
    const relative = pkg.main.replace(/^\.\//, "");
    if (path.isAbsolute(relative)) return null;
    const root = path.resolve(asarDir);
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(root + path.sep) || !fs.statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

function findMainEntries(platform) {
  const allPlatforms = ["mac-arm64", "mac-x64", "win"];
  const platforms = platform
    ? [platform]
    : allPlatforms.filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );
  const bundles = [];

  for (const currentPlatform of platforms) {
    const asarDir = path.join(SRC_DIR, currentPlatform, "_asar");
    const declaredMain = resolveDeclaredMain(asarDir);
    if (declaredMain) {
      bundles.push({ platform: currentPlatform, path: declaredMain });
      continue;
    }

    const buildDir = path.join(asarDir, ".vite", "build");
    const files = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
    const selected = selectMainEntry(files);
    if (selected) {
      bundles.push({ platform: currentPlatform, path: path.join(buildDir, selected) });
    }
  }

  return bundles;
}

function patchMainEntry(source) {
  if (source.includes(MAIN_MARKER)) {
    return { changed: false, source };
  }
  const next = MAIN_INJECT + source;
  acorn.parse(next, { ecmaVersion: 2022, sourceType: "script" });
  return { changed: true, source: next };
}

// ─── Layer 2: Renderer Process Injection ────────────────────────

const ROUTE_PATTERN = /(["`])unarchive-conversation\1\s*:\s*(\w+)\(async\s*\(\s*(\w+)\s*,\s*\{\s*conversationId\s*:\s*(\w+)\s*\}\s*\)\s*=>\s*\{\s*await\s+\3\.unarchiveConversation\(\4\)\s*;?\s*\}\)/;
const APPMANAGER_PATTERN = /if\s*\(\s*(\w+)\s*==\s*null\s*\)\s*throw\s+(?:new\s+)?Error\s*\(\s*[`'"]No AppServerManager registered for hostId:\s*\$\{\s*(\w+)\s*\}\s*[`'"]\s*\)\s*;/;

function patchRendererBundle(source) {
  if (source.includes(RENDERER_MARKER)) {
    return { changed: false, source };
  }

  const appManagerMatch = source.match(APPMANAGER_PATTERN);
  if (appManagerMatch) {
    const mgrVar = appManagerMatch[1];
    const anchorEnd = appManagerMatch.index + appManagerMatch[0].length;
    const inject = `;${RENDERER_MARKER}try{globalThis.__codexAppServerManager=${mgrVar}}catch(_){};`;
    const next = source.slice(0, anchorEnd) + inject + source.slice(anchorEnd);
    acorn.parse(next, { ecmaVersion: "latest", sourceType: "module" });
    return { changed: true, source: next };
  }

  const match = source.match(ROUTE_PATTERN);
  if (!match) {
    return { changed: false, source, notFound: true };
  }

  const q = match[1];
  const wrapperFn = match[2];
  const mgrVar = match[3];
  const cidVar = match[4];
  const anchorEnd = match.index + match[0].length;

  const inject = [
    `,${RENDERER_MARKER}`,
    `${q}control-turn${q}:${wrapperFn}(async(${mgrVar},{threadId,prompt})=>{`,
    `globalThis.__codexAppServerManager=${mgrVar};`,
    `return await ${mgrVar}.sendRequest(${q}turn/start${q},{threadId,input:[{type:${q}text${q},text:prompt}],approvalPolicy:${q}never${q}});`,
    `}),`,
    `${q}control-interrupt${q}:${wrapperFn}(async(${mgrVar},{threadId})=>{`,
    `globalThis.__codexAppServerManager=${mgrVar};`,
    `return await ${mgrVar}.sendRequest(${q}turn/interrupt${q},{threadId,turnId:${q}${q}});`,
    `})`
  ].join("");

  const next = source.slice(0, anchorEnd) + inject + source.slice(anchorEnd);
  acorn.parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { changed: true, source: next };
}

// ─── Main Dispatcher ────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  // 1. Patch Main Entry
  console.log("== [layer 1] Main Process HTTP Control Server ==");
  const mainBundles = findMainEntries(platform);
  if (mainBundles.length === 0) {
    console.log("  [skip] No main process entry found");
  } else {
    for (const bundle of mainBundles) {
      const code = fs.readFileSync(bundle.path, "utf-8");
      try {
        const { changed, source } = patchMainEntry(code);
        if (!changed) {
          console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
        } else if (isCheck) {
          console.log(`  [?] ${relPath(bundle.path)}: would inject main control server`);
        } else {
          fs.writeFileSync(bundle.path, source, "utf-8");
          console.log(`  [ok] ${relPath(bundle.path)}: injected main control server`);
        }
      } catch (e) {
        console.error(`  [x] ${relPath(bundle.path)}: patch failed (${e.message})`);
        process.exitCode = 1;
      }
    }
  }

  // 2. Patch Renderer Bundles
  console.log("\n== [layer 2] Renderer App Control Hooks ==");
  const rendererBundles = locateBundles({
    dir: "assets",
    pattern: /^app-(?:main|initial)-.*\.js$/,
    ...(platform ? { platform } : {}),
  });

  if (rendererBundles.length === 0) {
    console.log("  [skip] No renderer bundle found");
  } else {
    for (const bundle of rendererBundles) {
      const code = fs.readFileSync(bundle.path, "utf-8");
      try {
        const { changed, source, notFound } = patchRendererBundle(code);
        if (notFound) {
          console.log(`  [--] ${relPath(bundle.path)}: no control hook anchor here, skipping`);
        } else if (!changed) {
          console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
        } else if (isCheck) {
          console.log(`  [?] ${relPath(bundle.path)}: would inject control hooks`);
        } else {
          fs.writeFileSync(bundle.path, source, "utf-8");
          console.log(`  [ok] ${relPath(bundle.path)}: injected control hooks`);
        }
      } catch (e) {
        console.error(`  [x] ${relPath(bundle.path)}: patch failed (${e.message})`);
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  APPMANAGER_PATTERN,
  MAIN_MARKER,
  RENDERER_MARKER,
  patchMainEntry,
  patchRendererBundle,
  ROUTE_PATTERN,
};
