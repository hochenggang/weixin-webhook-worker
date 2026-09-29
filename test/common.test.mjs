/**
 * common.js 的纯逻辑单测。不 mock 全局 fetch，不依赖 Workers 运行时。
 *
 * 全部通过注入驱动：HTTP 用假 fetch，密钥用明文常量。
 */

import assert from "node:assert/strict";
import {
  createAccount,
  createIlink,
  createTicketSigner,
  MAX_TEXT_LENGTH,
  normalizeText,
  normalizeVerifyCode,
  randomToken,
  readBearerToken,
  STALE_TOKEN_ERRCODE,
  tokenMatches,
} from "../src/common.js";

let passed = 0;
let failed = 0;
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

/* -------------------- 假的 iLink 上游 -------------------- */
function makeUpstream() {
  const log = [];
  const state = {
    qrStatus: "wait",
    /** 下一次 sendmessage 的 ret（0 = 成功），消费一次后复位 */
    sendRet: 0,
    /** 下一次 sendmessage 的 errcode，消费一次后复位 */
    sendErrcode: 0,
    sendErrmsg: "跨域请求被上游拒绝",
    /** 成功响应里附带的 errmsg（正常是空串），消费一次后复位 */
    sendSuccessErrmsg: "",
    /** 成功响应里额外塞的 message_id：协议没有这个字段，用来验证我们不把它当判据 */
    sendMessageId: "MSG-X",
    /** 前 N 次 get_qrcode_status 直接网络失败（模拟长轮询中断） */
    qrNetworkFailTimes: 0,
  };

  const fetchImpl = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(init.body) : null;
    log.push({ path, method: init?.method, body, headers: init?.headers });

    if (path.endsWith("/get_bot_qrcode")) {
      return Response.json({ qrcode: "QR-1", qrcode_img_content: "https://weixin.qq.com/x/QR-1" });
    }
    if (path.endsWith("/get_qrcode_status")) {
      if (state.qrNetworkFailTimes > 0) {
        state.qrNetworkFailTimes -= 1;
        throw new Error("socket hang up");
      }
      if (state.qrStatus === "confirmed") {
        return Response.json({
          status: "confirmed",
          bot_token: "TOKEN-X",
          ilink_bot_id: "BOT-X",
          ilink_user_id: "USER-X",
          baseurl: "https://ilinkai.weixin.qq.com/",
        });
      }
      if (state.qrStatus === "scaned_but_redirect") {
        return Response.json({ status: "scaned_but_redirect", redirect_host: "sg.ilinkai.weixin.qq.com" });
      }
      return Response.json({ status: state.qrStatus });
    }
    if (path.endsWith("/sendmessage")) {
      const ret = state.sendRet;
      const errcode = state.sendErrcode;
      const successErrmsg = state.sendSuccessErrmsg;
      const messageId = state.sendMessageId;
      state.sendRet = 0;
      state.sendErrcode = 0;
      state.sendSuccessErrmsg = "";
      state.sendMessageId = "MSG-X";
      if (ret !== 0) return Response.json({ ret, errmsg: state.sendErrmsg });
      if (errcode !== 0) return Response.json({ ret: 0, errcode, errmsg: state.sendErrmsg });
      return Response.json({
        ret: 0,
        errmsg: successErrmsg,
        ...(messageId === null ? {} : { message_id: messageId }),
      });
    }
    throw new Error("unexpected upstream path: " + path);
  };

  return { fetchImpl, log, state };
}

const ilinkOf = (upstream) => createIlink({ fetch: upstream.fetchImpl });

/* ============================ 工具函数 ============================ */

console.log("\n[工具] 令牌与文本校验");
await test("tokenMatches 相同值通过", () => {
  assert.equal(tokenMatches("abc123", "abc123"), true);
});
await test("tokenMatches 不同值不通过", () => {
  assert.equal(tokenMatches("abc123", "abc124"), false);
});
await test("tokenMatches 长度不同也不通过", () => {
  assert.equal(tokenMatches("abc", "abcdef"), false);
});
await test("tokenMatches 空值一律不通过", () => {
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("x", ""), false);
});
await test("readBearerToken 解析标准头", () => {
  assert.equal(readBearerToken("Bearer " + "a".repeat(32)), "a".repeat(32));
});
await test("readBearerToken 拒绝过短令牌", () => {
  assert.equal(readBearerToken("Bearer short"), null);
});
await test("readBearerToken 拒绝缺失头", () => {
  assert.equal(readBearerToken(null), null);
  assert.equal(readBearerToken("Basic zzz"), null);
});
await test("randomToken 生成 URL 安全字符且长度足够", () => {
  const token = randomToken(32);
  assert.match(token, /^[A-Za-z0-9_-]+$/u);
  assert.ok(token.length >= 40, "32 字节 base64url 应不少于 40 字符");
});
await test("normalizeText 去空白后返回", () => {
  assert.equal(normalizeText("  你好  "), "你好");
});
await test("normalizeText 拒绝空串与纯空白", () => {
  assert.throws(() => normalizeText(""), /text_required/);
  assert.throws(() => normalizeText("   "), /text_required/);
  assert.throws(() => normalizeText(null), /text_required/);
});
await test("normalizeText 拒绝超长文本", () => {
  assert.throws(() => normalizeText("a".repeat(MAX_TEXT_LENGTH + 1)), /text_too_long/);
});
await test("normalizeVerifyCode 放行 undefined 与合法数字", () => {
  assert.equal(normalizeVerifyCode(undefined), undefined);
  assert.equal(normalizeVerifyCode("123456"), "123456");
});
await test("normalizeVerifyCode 拒绝非数字与超长", () => {
  assert.throws(() => normalizeVerifyCode("12a"), /invalid_verify_code/);
  assert.throws(() => normalizeVerifyCode("1234567890123"), /invalid_verify_code/);
});

/* ============================ 票据签名 ============================ */

console.log("\n[票据] 无状态签名往返");
const signer = createTicketSigner({ secret: "unit-test-secret-0123456789abcdef" });

await test("seal → open 往返一致", async () => {
  const token = await signer.seal({ qrcode: "QR-1", baseUrl: "https://a.example/" });
  const payload = await signer.open(token);
  assert.equal(payload.qrcode, "QR-1");
  assert.equal(payload.baseUrl, "https://a.example/");
});
await test("篡改载荷导致验签失败", async () => {
  const token = await signer.seal({ qrcode: "QR-1", baseUrl: "https://a.example/" });
  const [body, signature] = token.split(".");
  const forged = btoa(JSON.stringify({ qrcode: "QR-2", baseUrl: "https://a.example/", iat: 1, exp: 9e9 }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  assert.equal(await signer.open(`${forged}.${signature}`), null);
});
await test("换密钥的票据无法打开", async () => {
  const other = createTicketSigner({ secret: "another-secret-0123456789abcdefgh" });
  const token = await signer.seal({ qrcode: "QR-1", baseUrl: "https://a.example/" });
  assert.equal(await other.open(token), null);
});
await test("seal 拒绝签发已过期的票据", async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  await assert.rejects(
    () => signer.seal({ qrcode: "QR-1", baseUrl: "https://a.example/", iat: past, exp: past + 1 }),
    /invalid_qr_ticket/,
  );
});
await test("签名有效但已过期的票据无法打开", async () => {
  // 借一个长有效期把票据签出来，再手动把载荷改成过去的时间并重签，
  // 以覆盖「签名对但时间已过」这条路径。
  const now = Math.floor(Date.now() / 1000);
  const token = await signer.seal({ qrcode: "QR-1", baseUrl: "https://a.example/", iat: now, exp: now + 1 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await signer.open(token), null, "过期的票据不应被接受");
});
await test("畸形票据被安全拒绝", async () => {
  assert.equal(await signer.open("garbage"), null);
  assert.equal(await signer.open("a.b.c"), null);
  assert.equal(await signer.open(undefined), null);
});
await test("保留剩余有效期，不会被顺延", async () => {
  const soon = Math.floor(Date.now() / 1000) + 20;
  const token = await signer.seal({ qrcode: "QR-1", baseUrl: "https://a/", iat: soon - 60, exp: soon });
  const payload = await signer.open(token);
  assert.equal(payload.exp, soon, "exp 应保持不变");
});
await test("过短的签名密钥被拒绝", () => {
  assert.throws(() => createTicketSigner({ secret: "short" }), /ticket_secret_not_configured/);
});
await test("两者都不给时被拒绝", () => {
  assert.throws(() => createTicketSigner({}), /ticket_secret_not_configured/);
});

/* -------------------- 自举密钥：零配置路径 -------------------- */

await test("provideSecret 自举：签发与验签往返一致", async () => {
  const bootstrapped = createTicketSigner({
    provideSecret: async () => "bootstrapped-secret-0123456789abcdef",
  });
  const token = await bootstrapped.seal({ qrcode: "QR-B", baseUrl: "https://a/" });
  const payload = await bootstrapped.open(token);
  assert.equal(payload.qrcode, "QR-B");
});

await test("跨实例读到旧密钥时，丢弃缓存重取后可验签", async () => {
  // 模拟 KV 最终一致：实例 A 生成并签发，实例 B 一开始读到的是旧值。
  let stored = "first-secret-0000000000000000000";
  const signerA = createTicketSigner({ provideSecret: async () => stored });
  const token = await signerA.seal({ qrcode: "QR-C", baseUrl: "https://a/" });

  let reads = 0;
  const signerB = createTicketSigner({
    provideSecret: async () => {
      reads += 1;
      // 首次读到过期值，之后读到最新值。
      return reads === 1 ? "stale-secret-9999999999999999999" : stored;
    },
  });
  const payload = await signerB.open(token);
  assert.ok(payload, "重取密钥后应能验签成功");
  assert.equal(payload.qrcode, "QR-C");
  assert.equal(reads, 2, "首次用旧值失败，重取一次成功");
});

await test("固定密钥不重试（无自举来源）", async () => {
  const signerA = createTicketSigner({ secret: "secret-aaaaaaaaaaaaaaaaaaaa" });
  const token = await signerA.seal({ qrcode: "QR-E", baseUrl: "https://a/" });
  const signerB = createTicketSigner({ secret: "secret-bbbbbbbbbbbbbbbbbbbb" });
  assert.equal(await signerB.open(token), null, "密钥不同应直接判失败，不重试");
});

await test("固定密钥优先于 provideSecret", async () => {
  let called = 0;
  const both = createTicketSigner({
    secret: "fixed-secret-0123456789abcdef",
    provideSecret: async () => { called += 1; return "dynamic-secret"; },
  });
  await both.seal({ qrcode: "QR-D", baseUrl: "https://a/" });
  assert.equal(called, 0, "配了固定密钥就不该去自举");
});

/* ============================ iLink 协议 ============================ */

console.log("\n[iLink] 注入式 HTTP 驱动");
await test("startQr 解析二维码与登录节点", async () => {
  const upstream = makeUpstream();
  const qr = await ilinkOf(upstream).startQr([]);
  assert.equal(qr.qrcode, "QR-1");
  assert.equal(qr.qrcodeImgContent, "https://weixin.qq.com/x/QR-1");
  assert.equal(qr.baseUrl, "https://ilinkai.weixin.qq.com/");
});
await test("startQr 带上既有 token 列表", async () => {
  const upstream = makeUpstream();
  await ilinkOf(upstream).startQr(["t1", "t2"]);
  const call = upstream.log.find((entry) => entry.path.endsWith("/get_bot_qrcode"));
  assert.deepEqual(call.body.local_token_list, ["t1", "t2"]);
});
await test("pollQr 透传 wait", async () => {
  const upstream = makeUpstream();
  upstream.state.qrStatus = "wait";
  const result = await ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "https://ilinkai.weixin.qq.com/" });
  assert.equal(result.status, "wait");
});
await test("pollQr 处理 redirect 并解析节点", async () => {
  const upstream = makeUpstream();
  upstream.state.qrStatus = "scaned_but_redirect";
  const result = await ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "https://ilinkai.weixin.qq.com/" });
  assert.equal(result.status, "redirect");
  assert.equal(result.baseUrl, "https://sg.ilinkai.weixin.qq.com/");
});
await test("pollQr confirmed 返回完整凭证", async () => {
  const upstream = makeUpstream();
  upstream.state.qrStatus = "confirmed";
  const result = await ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "https://ilinkai.weixin.qq.com/" });
  assert.equal(result.status, "confirmed");
  assert.equal(result.account.botToken, "TOKEN-X");
  assert.equal(result.account.scannerUserId, "USER-X");
});
await test("pollQr 未知状态归一为 unknown", async () => {
  const upstream = makeUpstream();
  upstream.state.qrStatus = "something_new";
  const result = await ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "https://ilinkai.weixin.qq.com/" });
  assert.equal(result.status, "unknown");
});
await test("pollQr 拒绝非法 baseUrl（非 https）", async () => {
  const upstream = makeUpstream();
  await assert.rejects(
    () => ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "http://evil.example/" }),
    /invalid_weixin_base_url/,
  );
});

/* ---------------- 长轮询重试：把瞬时失败消化在内部 ---------------- */
await test("pollQr 瞬时网络失败后自动重试并成功", async () => {
  const upstream = makeUpstream();
  upstream.state.qrNetworkFailTimes = 1;
  upstream.state.qrStatus = "confirmed";
  const result = await ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "https://a/" });
  assert.equal(result.status, "confirmed", "重试后应拿到确认结果");
  assert.equal(
    upstream.log.filter((entry) => entry.path.endsWith("/get_qrcode_status")).length,
    2,
    "应重试 1 次后成功（共 2 次请求）",
  );
});
await test("pollQr 持续失败时最终抛出，不会无限重试", async () => {
  const upstream = makeUpstream();
  upstream.state.qrNetworkFailTimes = 99;
  await assert.rejects(
    () => ilinkOf(upstream).pollQr({ qrcode: "QR-1", baseUrl: "https://a/" }),
    /weixin_upstream_unreachable/,
  );
  assert.equal(
    upstream.log.filter((entry) => entry.path.endsWith("/get_qrcode_status")).length,
    3,
    "重试预算耗尽后应停止（默认 3 次）",
  );
});
await test("sendText 请求体不带 context_token（单向推送没有会话可回复）", async () => {
  const upstream = makeUpstream();
  const result = await ilinkOf(upstream).sendText({ baseUrl: "https://a/", botToken: "t", recipient: "r" }, "hi");
  assert.equal(result.ret, 0);
  const sent = upstream.log.at(-1).body;
  assert.equal("context_token" in sent.msg, false, "不应出现 context_token 字段");
});
await test("sendText 缺收件人时报错", async () => {
  const upstream = makeUpstream();
  await assert.rejects(
    () => ilinkOf(upstream).sendText({ baseUrl: "https://a/", botToken: "t" }, "hi"),
    /account_send_not_configured/,
  );
});
await test("sendText ret!=0 时把上游的 ret 与 errmsg 原样带出", async () => {
  const upstream = makeUpstream();
  upstream.state.sendRet = -2;
  const error = await ilinkOf(upstream)
    .sendText({ baseUrl: "https://a/", botToken: "t", recipient: "r" }, "hi")
    .then(() => null, (caught) => caught);
  assert.equal(error.message, "weixin_send_failed");
  assert.equal(error.upstreamStatus, 200);
  assert.equal(error.upstream.ret, -2, "字段名用协议里的 ret，不改名");
  assert.equal(error.upstream.errmsg, "跨域请求被上游拒绝", "上游原话要能带出来");
});
await test("sendText errcode=-14 归类为 bot 令牌失活", async () => {
  const upstream = makeUpstream();
  upstream.state.sendErrcode = STALE_TOKEN_ERRCODE;
  const error = await ilinkOf(upstream)
    .sendText({ baseUrl: "https://a/", botToken: "t", recipient: "r" }, "hi")
    .then(() => null, (caught) => caught);
  assert.equal(error.message, "weixin_bot_token_stale");
  assert.equal(error.upstream.errcode, STALE_TOKEN_ERRCODE, "应带出上游 errcode 供诊断");
});
await test("sendText ret=0 但 errmsg 非空时不得算成功", async () => {
  // 上游「嘴上说成功、实际附了错误描述」——这正是我们以前会误报 ok 的情形。
  const upstream = makeUpstream();
  upstream.state.sendSuccessErrmsg = "content_miss";
  const error = await ilinkOf(upstream)
    .sendText({ baseUrl: "https://a/", botToken: "t", recipient: "r" }, "hi")
    .then(() => null, (caught) => caught);
  assert.equal(error.message, "weixin_send_failed");
  assert.equal(error.upstream.ret, 0, "上游说什么就照抄什么");
  assert.equal(error.upstream.errmsg, "content_miss", "错误描述不能被吞掉");
});
await test("sendText 成功时原样返回上游字段，不多带协议外的字段", async () => {
  const upstream = makeUpstream();
  const result = await ilinkOf(upstream).sendText(
    { baseUrl: "https://a/", botToken: "t", recipient: "r" },
    "hi",
  );
  // 上游响应里塞了一个协议没定义的 message_id，我们不应把它带进响应。
  assert.deepEqual(result, { ret: 0, errmsg: "" });
});
await test("未注入 fetch 时立即报错", () => {
  assert.throws(() => createIlink({}), /fetch_not_injected/);
});

/* ==================== 账号记录 ==================== */

console.log("\n[账号] 扫码结果 → 账号记录");
await test("createAccount 只保留推送链路需要的字段", () => {
  const account = createAccount(
    { botToken: "t", botId: "b", baseUrl: "https://a/", scannerUserId: "USER-X" },
    { notifyToken: "NT" },
  );
  assert.deepEqual(
    Object.keys(account).sort(),
    ["baseUrl", "botId", "botToken", "createdAt", "notifyToken", "recipient"],
  );
  assert.equal(account.recipient, "USER-X", "默认收件人就是扫码用户");
  assert.ok(Number.isSafeInteger(account.createdAt), "createdAt 应为毫秒时间戳");
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
