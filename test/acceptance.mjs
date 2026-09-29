/**
 * index.js 的 HTTP 层验收。用假 KV + 假上游驱动 Workers 入口。
 *
 * 关注的是路由、鉴权、状态码与错误映射；协议细节由 common.test.mjs 覆盖。
 */

import assert from "node:assert/strict";
import { register } from "node:module";

import { MAX_TEXT_LENGTH, STALE_TOKEN_ERRCODE } from "../src/common.js";

// Worker 侧由 wrangler 把 .html 内联成字符串，Node 侧靠这个钩子做到一致。
// 必须在导入 src/index.js 之前注册。
register("./html-loader.mjs", import.meta.url);

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
  const calls = { qrStart: 0, qrPoll: 0, send: 0, sendBodies: [] };
  const state = {
    qrStatus: "wait",
    /** 下一次 sendmessage 的 ret（0 = 成功），消费一次后复位 */
    sendRet: 0,
    /** 下一次 sendmessage 的 errcode，消费一次后复位 */
    sendErrcode: 0,
    sendErrmsg: "上游拒绝了这条消息",
    /** 上游在 ret=0 时附带的错误描述，消费一次后复位 */
    sendSuccessErrmsg: "",
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
    if (path.endsWith("/sendmessage")) {
      calls.send += 1;
      calls.sendBodies.push(body);
      if (state.sendErrcode !== 0) {
        const errcode = state.sendErrcode;
        state.sendErrcode = 0;
        return Response.json({ ret: 0, errcode, errmsg: state.sendErrmsg });
      }
      if (state.sendRet !== 0) {
        const ret = state.sendRet;
        state.sendRet = 0;
        return Response.json({ ret, errmsg: state.sendErrmsg });
      }
      const errmsg = state.sendSuccessErrmsg;
      state.sendSuccessErrmsg = "";
      return Response.json({ ret: 0, errmsg });
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

await test("GET /init 返回完整页面（来自 src/init.html）", async () => {
  const res = await call("/init");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /^<!doctype html>/i, "应当是完整的 HTML 文档");
  assert.match(body, /#1a9d5e/, "缺少主色 #1a9d5e");
  assert.match(body, /#aad39c/, "缺少中间色 #aad39c");
  assert.match(body, /#dce7dc/, "缺少浅色 #dce7dc");
  assert.match(body, /border: 10px solid/, "缺少 10px 边框");
  assert.match(body, /api\/init\/start/, "缺少初始化脚本");
});
await test("页脚强调「先发消息」并用主题深绿", async () => {
  const body = await (await call("/init")).text();
  // 允许标签带其他属性（页面可能由可视化编辑器再加工过）。
  assert.match(body, /<strong[^>]*>先<\/strong>/, "「先」应被强调");
  assert.match(body, /<strong[^>]*>发<\/strong>/, "「发」应被强调");
  assert.match(body, /footer strong\s*\{[^}]*var\(--deep\)/, "强调色应为主题深绿");
});

/**
 * 从页面开头数到 `index` 为止的 `<div>` 净深度。
 *
 * 这一层没有 HTML 解析器，但布局已经栽过一次：少一个 `</div>`（或早关一层）
 * 会让 `<footer>` 掉到 `.card` 外面、成为 `.page`（`display:flex`）的第二个
 * 子元素，于是页脚和卡片并排渲染。这两个小函数就能把这类错误钉住。
 */
function divDepthBefore(html, index) {
  let depth = 0;
  for (const token of html.matchAll(/<div\b[^>]*>|<\/div>/g)) {
    if (token.index > index) break;
    depth += token[0] === "</div>" ? -1 : 1;
  }
  return depth;
}

await test("页面 div 配平，且页脚嵌在卡片内部", async () => {
  const body = await (await call("/init")).text();
  assert.equal(divDepthBefore(body, body.length), 0, "div 未配平：多一个 </div> 会提前关掉 .card");
  const footerAt = body.indexOf("<footer");
  assert.ok(footerAt > 0, "页面里应当有页脚");
  assert.ok(
    divDepthBefore(body, footerAt) >= 1,
    "页脚必须在 .card 内部，否则它会成为 .page 的第二个 flex 子元素而并排显示",
  );
});

await test("收件人写进专用元素，不整段覆盖页脚", async () => {
  const body = await (await call("/init")).text();
  assert.match(body, /id="outRecipient"/, "收件人应有自己的元素");
  assert.equal(
    body.includes('querySelector("footer").textContent'),
    false,
    "覆盖 footer 的 textContent 会抹掉里面的 <strong> 强调",
  );
});

await test("页面不含可视化编辑器注入的节点标记", async () => {
  const body = await (await call("/init")).text();
  assert.equal(body.includes("data-page-node-id"), false, "编辑器注入的属性不应进入交付物");
});
await test("验证码输入默认隐藏，且真的藏得住（不被 .verify 的 display 盖掉）", async () => {
  const body = await (await call("/init")).text();
  assert.match(body, /<form id="verifyForm"[^>]*hidden/, "验证码表单应默认隐藏");
  assert.match(body, /verifyForm\.hidden = false/, "需要验证码时应由脚本显示出来");
  // hidden 只是 UA 样式表里的一条规则，作者样式里的 display:flex 会盖过它，
  // 因此必须在本页样式表里显式声明隐藏，否则表单会一直显示。
  assert.match(
    body,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "缺少 [hidden] 的显式隐藏规则：.verify 的 display:flex 会盖过浏览器默认行为",
  );
});
await test("GET /init 的 CSP 允许同源 fetch（否则二维码加载不出来）", async () => {
  const csp = (await call("/init")).headers.get("Content-Security-Policy") || "";
  assert.ok(csp, "缺少 Content-Security-Policy 头");
  // 关键：default-src 是 'none'，若 connect-src 未显式声明，fetch 会回退被拒。
  const connect = (csp.match(/connect-src([^;]*)/) || [])[1] || "";
  assert.ok(connect.trim(), "CSP 缺少 connect-src，会回退到 default-src 'none' 而拦截同源请求");
  assert.ok(!/^'none'$/.test(connect.trim()), "connect-src 不能是 'none'");
  assert.ok(connect.includes("'self'"), "connect-src 需包含 'self' 以放行同源 /api/init/*");

  // 页面的请求目标必须全是同源相对路径，'self' 才够用。
  const body = await (await call("/init")).text();
  const targets = [...body.matchAll(/post\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, "未找到页面的 post() 调用");
  for (const t of targets) {
    assert.ok(t.startsWith("/"), `请求目标 ${t} 不是同源相对路径，CSP connect-src 'self' 会拦截`);
  }
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
  assert.equal(stored.recipient, "USER-SCANNER-1", "默认收件人应为扫码用户");
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
  assert.equal((await notify({ text: "a".repeat(MAX_TEXT_LENGTH + 1) })).status, 413);
});
await test("非 JSON 请求体 415", async () => {
  const res = await call("/notify", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: "Bearer " + token },
    body: "hello",
  });
  assert.equal(res.status, 415);
});
await test("首次通知：直接发送，响应原样带上上游字段", async () => {
  const res = await notify({ text: "这是一条微信通知" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, ret: 0, errmsg: "" }, "成功响应 = ok + 上游字段，不多不少");
  const sent = upstream.calls.sendBodies.at(-1);
  assert.equal(sent.msg.to_user_id, "USER-SCANNER-1");
  assert.equal("context_token" in sent.msg, false, "不带 context_token");
  assert.equal(sent.msg.message_type, 2);
  assert.equal(sent.msg.item_list[0].text_item.text, "这是一条微信通知");
});
await test("发送链路不写 KV（没有状态需要维护）", async () => {
  const before = env.WEIXIN_KV.map.get("account");
  assert.equal((await notify({ text: "第二条" })).status, 200);
  assert.equal(env.WEIXIN_KV.map.get("account"), before, "发送成功后不应落库");
});
await test("一次通知只发一次请求，不做任何重试", async () => {
  const sendsBefore = upstream.calls.send;
  assert.equal((await notify({ text: "第三条" })).status, 200);
  assert.equal(upstream.calls.send, sendsBefore + 1, "一次通知只应发一次");
});

/* ==================== 失败透传（不做任何补救） ==================== */
console.log("\n[失败透传]");

await test("上游拒绝时原样带出 ret / errmsg，且不做重试", async () => {
  upstream.state.sendRet = -2;
  const sendsBefore = upstream.calls.send;
  const res = await notify({ text: "会被拒" });
  assert.equal(res.status, 502);
  assert.equal(upstream.calls.send, sendsBefore + 1, "失败应直接透出，不该再补发一次");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "weixin_send_failed");
  assert.equal(body.upstreamStatus, 200);
  assert.equal(body.ret, -2, "字段名沿用协议里的 ret");
  assert.equal(body.errmsg, "上游拒绝了这条消息", "上游原话要能看到");
});
await test("ret=0 但上游附了错误描述时，不得报成功", async () => {
  // 这正是「接口说 ok、消息却没到」的情形：上游嘴上说成功、errmsg 却非空。
  upstream.state.sendSuccessErrmsg = "content_miss";
  const res = await notify({ text: "会被丢弃" });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.ret, 0, "上游说什么就照抄什么");
  assert.equal(body.errmsg, "content_miss", "错误描述不能被吞掉");
});
await test("errcode=-14 归类为令牌失活并返回 503", async () => {
  upstream.state.sendErrcode = STALE_TOKEN_ERRCODE;
  const res = await notify({ text: "令牌失活" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "weixin_bot_token_stale");
  assert.equal(body.errcode, STALE_TOKEN_ERRCODE);
});

/* ============================ 反向自检 ============================ */
console.log("\n[反向自检]");

await test("失败状态复位后，正常发送仍然可用", async () => {
  upstream.state.sendRet = 0;
  upstream.state.sendErrcode = 0;
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

/* ==================== 解绑路径（只在控制台，服务端不提供接口） ==================== */
console.log("\n[解绑]");

await test("已绑定后：/init 一律 404，也没有任何解绑接口", async () => {
  assert.equal((await call("/init")).status, 404);
  // 服务端刻意不提供 reset 能力：带了参数也不能删数据。
  assert.equal((await call("/init?reset=" + encodeURIComponent(token))).status, 404);
  assert.ok(env.WEIXIN_KV.map.has("account"), "账号记录不该被动过");
  assert.equal((await postJson("/api/init/reset", {})).status, 404, "不应存在解绑接口");
});

globalThis.fetch = realFetch;

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
