/**
 * index.js 的 HTTP 层验收。用假 KV + 假上游驱动 Workers 入口。
 *
 * 关注的是路由、鉴权、状态码与错误映射；协议细节由 common.test.mjs 覆盖。
 */

import assert from "node:assert/strict";

/* ---------------------------- 假的 KV ---------------------------- */
function makeKV() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

/* ------------------------ 假的 iLink 上游 ------------------------ */
function makeUpstream() {
  const calls = { qrStart: 0, qrPoll: 0, updates: 0, send: 0, updatesBodies: [], sendBodies: [] };
  const state = {
    qrStatus: "wait",
    /** 前 N 次 sendmessage 返回 ret=-2 */
    sendFailTimes: 0,
    /** 当前是否还有可捕获的上下文 */
    hasContext: true,
  };

  const fetchImpl = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(init.body) : null;

    if (path.endsWith("/get_bot_qrcode")) {
      calls.qrStart += 1;
      return Response.json({ qrcode: "QR-TOKEN-1", qrcode_img_content: "https://weixin.qq.com/x/QR-TOKEN-1" });
    }
    if (path.endsWith("/get_qrcode_status")) {
      calls.qrPoll += 1;
      if (state.qrStatus === "confirmed") {
        return Response.json({
          status: "confirmed",
          bot_token: "BOT-TOKEN-ABC",
          ilink_bot_id: "BOT-ID-1",
          ilink_user_id: "USER-SCANNER-1",
          baseurl: "https://ilinkai.weixin.qq.com/",
        });
      }
      return Response.json({ status: state.qrStatus });
    }
    if (path.endsWith("/getupdates")) {
      calls.updates += 1;
      calls.updatesBodies.push(body);
      // 游标为空时才重放历史，模拟上游"已消费不再重发"的语义。
      const replaying = !body.get_updates_buf;
      const msgs = state.hasContext && replaying
        ? [{ from_user_id: "USER-SCANNER-1", context_token: "CTX-1" }]
        : [];
      return Response.json({ ret: 0, get_updates_buf: "BUF-2", msgs });
    }
    if (path.endsWith("/sendmessage")) {
      calls.send += 1;
      calls.sendBodies.push(body);
      if (state.sendFailTimes > 0) {
        state.sendFailTimes -= 1;
        return Response.json({ ret: -2 });
      }
      return Response.json({ ret: 0, message_id: "MSG-1" });
    }
    throw new Error("unexpected upstream path: " + path);
  };

  return { fetchImpl, calls, state };
}

/* --------------------------- 装载 Worker --------------------------- */
const upstream = makeUpstream();
const realFetch = globalThis.fetch;
globalThis.fetch = upstream.fetchImpl;

const { default: worker } = await import("../src/index.js");

// 刻意不提供 NOTIFY_TOKEN：验证「零配置」路径下签名密钥能自动生成。
const env = {
  WEIXIN_KV: makeKV(),
  WEIXIN_CHANNEL_VERSION: "2.4.9",
  WEIXIN_APP_ID: "bot",
};

const ORIGIN = "https://wx.example.workers.dev";
const call = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const postJson = (path, body) =>
  call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });

let passed = 0;
let failed = 0;
let confirmedBody = null;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  \u2717 ${name}\n      ${error.message}`);
    failed += 1;
  }
}

/* ============================ 初始化前 ============================ */
console.log("\n[初始化前]");

await test("GET /init 返回内联样式的页面", async () => {
  const res = await call("/init");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /#1a9d5e/, "缺少主色 #1a9d5e");
  assert.match(body, /#aad39c/, "缺少中间色 #aad39c");
  assert.match(body, /#dce7dc/, "缺少浅色 #dce7dc");
  assert.match(body, /border: 10px solid/, "缺少 10px 边框");
  assert.match(body, /api\/init\/start/, "缺少初始化脚本");
});
await test("GET / 重定向到 /init", async () => {
  const res = await call("/", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), ORIGIN + "/init");
});
await test("POST /init 返回 405", async () => {
  assert.equal((await call("/init", { method: "POST" })).status, 405);
});
await test("/notify 未初始化返回 503", async () => {
  const res = await call("/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + "x".repeat(40) },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "not_initialized");
});
await test("未知路径返回 404", async () => {
  assert.equal((await call("/nope")).status, 404);
});
await test("GET /health 可用", async () => {
  assert.equal((await call("/health")).status, 200);
});

/* ============================ 扫码初始化 ============================ */
console.log("\n[扫码初始化]");
let initTicket = "";

await test("POST /api/init/start 返回二维码与票据", async () => {
  const res = await postJson("/api/init/start");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.qrSvg, /<svg/, "二维码未渲染为 SVG");
  assert.equal(body.ticket.split(".").length, 2, "票据格式不对");
  initTicket = body.ticket;
});
await test("poll: wait 原样返回", async () => {
  upstream.state.qrStatus = "wait";
  const res = await postJson("/api/init/poll", { ticket: initTicket });
  assert.equal((await res.json()).status, "wait");
});
await test("poll: 伪造票据被拒 401", async () => {
  assert.equal((await postJson("/api/init/poll", { ticket: "AAAA.BBBB" })).status, 401);
});
await test("poll: 非法验证码被拒 400", async () => {
  const res = await postJson("/api/init/poll", { ticket: initTicket, verifyCode: "abc" });
  assert.equal(res.status, 400);
});
await test("poll: confirmed 后落库并下发令牌", async () => {
  upstream.state.qrStatus = "confirmed";
  const res = await postJson("/api/init/poll", { ticket: initTicket });
  confirmedBody = await res.json();
  const body = confirmedBody;
  assert.equal(body.status, "confirmed");
  assert.ok(body.notifyToken.length >= 40, "令牌长度不足");
  const stored = JSON.parse(env.WEIXIN_KV.map.get("account"));
  assert.equal(stored.botToken, "BOT-TOKEN-ABC");
  assert.equal(stored.recipient, stored.scannerUserId, "默认收件人应为扫码用户");
  assert.equal(stored.contextToken, "", "初始上下文应为空");
});
await test("poll: confirmed 后返回填好令牌的调用链接与 curl", async () => {
  const body = confirmedBody;
  assert.equal(body.endpoint, ORIGIN + "/notify");
  assert.ok(body.curl.includes(body.endpoint), "curl 应含接口地址");
  assert.ok(body.curl.includes("Authorization: Bearer " + body.notifyToken), "curl 应含已填好的令牌");
  assert.ok(body.curl.startsWith("curl -X POST"), "curl 应以 curl -X POST 开头");
});
await test("零配置：签名密钥自动生成并落进 KV", async () => {
  const secret = env.WEIXIN_KV.map.get("signing-secret");
  assert.ok(typeof secret === "string" && secret.length >= 16, "KV 里应已存下自举密钥");
});
await test("初始化后 /init 返回 404", async () => {
  assert.equal((await call("/init")).status, 404);
});
await test("初始化后重复 start 返回 409", async () => {
  const res = await postJson("/api/init/start");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "already_initialized");
});

/* ============================ 实时转发 ============================ */
console.log("\n[实时转发]");
const token = JSON.parse(env.WEIXIN_KV.map.get("account")).notifyToken;
const notify = (body, auth = "Bearer " + token) =>
  call("/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });

await test("错误令牌 401", async () => {
  assert.equal((await notify({ text: "hi" }, "Bearer " + "z".repeat(40))).status, 401);
});
await test("缺少 Authorization 401", async () => {
  const res = await call("/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(res.status, 401);
});
await test("空 text 400", async () => {
  assert.equal((await notify({ text: "   " })).status, 400);
});
await test("超长 text 413", async () => {
  assert.equal((await notify({ text: "a".repeat(4001) })).status, 413);
});
await test("非 JSON 请求体 415", async () => {
  const res = await call("/notify", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: "Bearer " + token },
    body: "hello",
  });
  assert.equal(res.status, 415);
});
await test("首次通知：自动补上下文后发送", async () => {
  const before = upstream.calls.updates;
  const res = await notify({ text: "这是一条微信通知" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).messageId, "MSG-1");
  assert.equal(upstream.calls.updates, before + 1, "应触发一次补上下文");
  const sent = upstream.calls.sendBodies.at(-1);
  assert.equal(sent.msg.to_user_id, "USER-SCANNER-1");
  assert.equal(sent.msg.context_token, "CTX-1");
  assert.equal(sent.msg.message_type, 2);
  assert.equal(sent.msg.item_list[0].text_item.text, "这是一条微信通知");
});
await test("状态已持久化", async () => {
  const stored = JSON.parse(env.WEIXIN_KV.map.get("account"));
  assert.equal(stored.getUpdatesBuf, "BUF-2");
  assert.equal(stored.contextToken, "CTX-1");
});
await test("第二次通知走缓存，不再拉取", async () => {
  const before = upstream.calls.updates;
  assert.equal((await notify({ text: "第二条" })).status, 200);
  assert.equal(upstream.calls.updates, before, "不应再次拉取");
});

/* ==================== 上下文失效的恢复（回归） ==================== */
console.log("\n[上下文失效恢复]");

await test("上下文失效：重置游标后能重新捕获并发送成功", async () => {
  upstream.state.sendFailTimes = 1;
  const updatesBefore = upstream.calls.updates;
  const res = await notify({ text: "第三条" });
  assert.equal(res.status, 200, "重试应成功");
  assert.ok(upstream.calls.updates > updatesBefore, "应重新拉取上下文");
  const bodies = upstream.calls.updatesBodies.slice(updatesBefore);
  assert.ok(
    bodies.some((body) => !body.get_updates_buf),
    "重建时必须用空游标拉取，否则上游不会重放历史消息",
  );
  const stored = JSON.parse(env.WEIXIN_KV.map.get("account"));
  assert.equal(stored.contextToken, "CTX-1", "上下文应被重新捕获");
});
await test("上游确实拿不到上下文时返回 409", async () => {
  upstream.state.sendFailTimes = 1;
  upstream.state.hasContext = false;
  const stored = JSON.parse(env.WEIXIN_KV.map.get("account"));
  stored.contextToken = "";
  await env.WEIXIN_KV.put("account", JSON.stringify(stored));
  const res = await notify({ text: "第四条" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "weixin_context_missing");
});

/* ============================ 反向自检 ============================ */
console.log("\n[反向自检]");

await test("恢复上下文后，正常发送仍可用", async () => {
  upstream.state.hasContext = true;
  upstream.state.sendFailTimes = 0;
  // 上一条测试把状态打成了「上下文为空 + 游标已推进」，先重置到可恢复状态。
  const stored = JSON.parse(env.WEIXIN_KV.map.get("account"));
  stored.contextToken = "";
  stored.getUpdatesBuf = "";
  await env.WEIXIN_KV.put("account", JSON.stringify(stored));
  assert.equal((await notify({ text: "第五条" })).status, 200);
});
await test("错误令牌不能绕过（证明鉴权真在跑）", async () => {
  assert.equal((await notify({ text: "hi" }, "Bearer " + "!".repeat(40))).status, 401);
});
await test("KV 记录损坏时报 500 而非静默成功", async () => {
  const brokenEnv = { ...env, WEIXIN_KV: { get: async () => "{ not json" } };
  const res = await worker.fetch(
    new Request(ORIGIN + "/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ text: "hi" }),
    }),
    brokenEnv,
  );
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "account_record_unreadable");
});

globalThis.fetch = realFetch;

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
