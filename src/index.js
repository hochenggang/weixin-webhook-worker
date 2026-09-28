/**
 * HTTP 适配层：把 common.js 的通用逻辑接到 Workers 运行时。
 *
 * 本文件只做四件事：解析请求、调用 common、落 KV、拼响应。
 * 任何可被复用的判断都不留在这一层。
 *
 * 路由：
 *   GET  /                 → 跳转 /init
 *   GET  /init             → 初始化页（已绑定则 404）
 *   POST /api/init/start   → 申请二维码
 *   POST /api/init/poll    → 推进扫码状态；确认后返回令牌
 *   POST /notify           → 实时转发文本
 *   GET  /health           → 健康检查
 */

import QRCode from "qrcode-svg";
import {
  accountChanged,
  applyUpdates,
  createAccount,
  createIlink,
  createTicketSigner,
  invalidateContext,
  normalizeText,
  normalizeVerifyCode,
  randomToken,
  readBearerToken,
  tokenMatches,
  TICKET_SECONDS,
} from "./common.js";
import { INIT_PAGE } from "./init-page.js";
import { getAccount, getOrCreateSigningSecret, putAccount } from "./store.js";

const MAX_BODY_BYTES = 16 * 1024;
const QR_RENDER_MAX = 64 * 1024;
const QR_SIZE = 240;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    }),
  });
}

function htmlResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
    },
  });
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
}

function methodNotAllowed(methods) {
  return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: methods.join(", ") });
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) throw new ApiError(415, "json_required");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large");

  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large");

  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

/**
 * 组装本次请求所需的能力：iLink 客户端、票据签名器。
 *
 * 签名密钥优先用部署时配置的 NOTIFY_TOKEN（可选，便于固定密钥）；
 * 未配置时从 KV 自举——首次访问自动生成，因此开箱即用、无需任何手填配置。
 */
function context(env) {
  return {
    ilink: createIlink({
      fetch,
      channelVersion: env.WEIXIN_CHANNEL_VERSION,
      appId: env.WEIXIN_APP_ID,
    }),
    signer: createTicketSigner({
      secret: configuredSecret(env),
      provideSecret: () => getOrCreateSigningSecret(env, () => randomToken()),
    }),
  };
}

/** 部署时若配置了 NOTIFY_TOKEN 就返回它，否则 undefined（走自举）。 */
function configuredSecret(env) {
  const value = typeof env.NOTIFY_TOKEN === "string" ? env.NOTIFY_TOKEN.trim() : "";
  return value || undefined;
}

/* ---------------------------- 初始化 ---------------------------- */

/**
 * 初始化页：未绑定返回扫码页；已绑定返回 404。
 *
 * 需要重新绑定时，到 Cloudflare 控制台的 KV 里删掉 account 这个 key，
 * 页面即恢复可访问（见 README）。
 */
async function handleInitPage(request, env) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (await getAccount(env)) return notFound();
  return htmlResponse(INIT_PAGE);
}

async function handleInitStart(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (await getAccount(env)) throw new ApiError(409, "already_initialized");

  const { ilink, signer } = context(env);
  const qr = await ilink.startQr([]);
  const ticket = await signer.seal({ qrcode: qr.qrcode, baseUrl: qr.baseUrl });

  const qrSvg = new QRCode({
    content: qr.qrcodeImgContent,
    padding: 4,
    width: QR_SIZE,
    height: QR_SIZE,
    color: "#1f2a24",
    background: "#ffffff",
    ecl: "M",
    join: true,
    container: "svg-viewbox",
    xmlDeclaration: false,
  }).svg();
  if (qrSvg.length > QR_RENDER_MAX) throw new ApiError(502, "qr_render_failed");

  return json({ ok: true, ticket, qrSvg, expiresAt: Date.now() + TICKET_SECONDS * 1000 });
}

async function handleInitPoll(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (await getAccount(env)) throw new ApiError(409, "already_initialized");

  const { ilink, signer } = context(env);
  const input = await readJson(request);
  const ticket = await signer.open(input.ticket);
  if (!ticket || typeof ticket.qrcode !== "string" || typeof ticket.baseUrl !== "string") {
    throw new ApiError(401, "invalid_or_expired_qr_ticket");
  }

  let verifyCode;
  try {
    verifyCode = normalizeVerifyCode(input.verifyCode);
  } catch (error) {
    throw new ApiError(400, error.message);
  }

  const result = await ilink.pollQr({ qrcode: ticket.qrcode, baseUrl: ticket.baseUrl, verifyCode });

  if (result.status === "redirect") {
    const nextTicket = await signer.seal({
      qrcode: ticket.qrcode,
      baseUrl: result.baseUrl,
      iat: ticket.iat,
      exp: ticket.exp,
    });
    return json({ ok: true, status: "redirect", ticket: nextTicket });
  }
  if (result.status !== "confirmed") return json({ ok: true, status: result.status });

  // 并发保护：写入前再查一次，避免两个会话同时绑定。
  if (await getAccount(env)) throw new ApiError(409, "already_initialized");

  const notifyToken = randomToken();
  const account = createAccount(result.account, { notifyToken });
  await putAccount(env, account);

  const endpoint = new URL("/notify", request.url).toString();
  return json({
    ok: true,
    status: "confirmed",
    notifyToken,
    endpoint,
    curl: buildCurl(endpoint, notifyToken),
    account: { recipient: account.recipient, botId: account.botId },
  });
}

/** 拼一段可直接粘到终端执行的 curl 示例，令牌已填好。 */
function buildCurl(endpoint, token) {
  return [
    `curl -X POST ${endpoint}`,
    `  -H "Authorization: Bearer ${token}"`,
    `  -H "Content-Type: application/json"`,
    `  -d '{"text": "来自 weixin-webhook-worker 的测试消息"}'`,
  ].join(" \\\n");
}

/* --------------------------- 实时转发 --------------------------- */

/** 拉取一轮增量消息并落库，返回最新的账号状态。 */
async function pullAndPersist(ilink, env, account) {
  const updates = await ilink.pullUpdates(account);
  const next = applyUpdates(account, updates);
  if (accountChanged(account, next)) await putAccount(env, next);
  return next;
}

async function handleNotify(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const account = await getAccount(env);
  if (!account || !account.notifyToken) throw new ApiError(503, "not_initialized");
  if (!tokenMatches(readBearerToken(request.headers.get("Authorization")), account.notifyToken)) {
    throw new ApiError(401, "unauthorized");
  }

  const input = await readJson(request);
  let text;
  try {
    text = normalizeText(input.text);
  } catch (error) {
    throw new ApiError(error.message === "text_too_long" ? 413 : 400, error.message);
  }

  const { ilink } = context(env);
  let current = account;

  // 首次或更换收件人后上下文为空：同步补一次，拿到就发。
  if (!current.contextToken) {
    current = await pullAndPersist(ilink, env, current);
  }

  try {
    const result = await ilink.sendText(current, text);
    return json({ ok: true, messageId: result.messageId });
  } catch (error) {
    if (error?.message !== "weixin_send_failed" || error.upstreamRet !== -2) throw error;

    // 上下文已失效：重置游标后重新捕获，再试一次。
    const reset = invalidateContext(current);
    await putAccount(env, reset);
    const refreshed = await pullAndPersist(ilink, env, reset);
    if (!refreshed.contextToken) throw new ApiError(409, "weixin_context_missing");

    const result = await ilink.sendText(refreshed, text);
    return json({ ok: true, messageId: result.messageId });
  }
}

/* ---------------------------- 错误映射 ---------------------------- */

const ERROR_STATUSES = new Map([
  ["ticket_secret_not_configured", 503],
  ["account_store_unavailable", 503],
  ["invalid_channel_version", 503],
  ["already_initialized", 409],
  ["not_initialized", 503],
  ["account_record_unreadable", 500],
  ["unauthorized", 401],
  ["invalid_or_expired_qr_ticket", 401],
  ["invalid_qr_ticket", 401],
  ["text_required", 400],
  ["text_too_long", 413],
  ["invalid_verify_code", 400],
  ["account_send_not_configured", 502],
  ["weixin_context_missing", 409],
  ["weixin_upstream_unreachable", 502],
  ["weixin_upstream_timeout", 504],
  ["weixin_qr_start_failed", 502],
  ["invalid_weixin_qr_response", 502],
  ["invalid_weixin_response", 502],
  ["weixin_response_too_large", 502],
  ["weixin_qr_poll_failed", 502],
  ["invalid_weixin_base_url", 502],
  ["invalid_weixin_redirect_host", 502],
  ["invalid_weixin_login_response", 502],
  ["weixin_send_failed", 502],
  ["weixin_updates_failed", 502],
  ["invalid_weixin_updates_response", 502],
  ["qr_render_failed", 502],
]);

function safeErrorResponse(error) {
  if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status);

  const code = typeof error?.message === "string" ? error.message : "";

  if (code === "weixin_send_failed") {
    return json({
      ok: false,
      error: code,
      ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
      ...(Number.isInteger(error.upstreamRet) ? { upstreamRet: error.upstreamRet } : {}),
      ...(Number.isInteger(error.upstreamErrcode) ? { upstreamErrcode: error.upstreamErrcode } : {}),
    }, 502);
  }

  const qrHttpFailure = /^weixin_qr_upstream_http_(\d{3})$/u.exec(code);
  if (qrHttpFailure) {
    return json({ ok: false, error: "weixin_qr_upstream_http_error", upstreamStatus: Number(qrHttpFailure[1]) }, 502);
  }

  const status = ERROR_STATUSES.get(code);
  if (status) return json({ ok: false, error: code }, status);
  return json({ ok: false, error: "internal_error" }, 500);
}

/* ------------------------------ 路由 ------------------------------ */

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/" || path === "") return Response.redirect(new URL("/init", url), 302);
  if (path === "/init" || path === "/init/") return handleInitPage(request, env);
  if (path === "/api/init/start") return handleInitStart(request, env);
  if (path === "/api/init/poll") return handleInitPoll(request, env);
  if (path === "/notify") return handleNotify(request, env);
  if (path === "/health") return json({ ok: true });

  return notFound();
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return safeErrorResponse(error);
    }
  },
};
