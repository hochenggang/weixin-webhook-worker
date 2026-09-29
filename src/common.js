/**
 * 运行时无关的通用逻辑。可在纯 Node 环境直接组合测试。
 *
 * 本模块不引用 Workers 专有 API：所有 I/O 能力（HTTP、加密、存储）
 * 都由调用方以参数注入。调用方只需知道"传入什么、拿回什么"。
 *
 * 组成：
 *   1. 协议调用      createIlink({ fetch, env })  → startQr / pollQr / sendText
 *   2. 票据签名      createTicketSigner({ secret })
 *   3. 令牌校验      tokenMatches / readBearerToken
 *
 * 只实现协议里真正用到的那部分：单向推送链路 = 扫码登录 + 发消息。
 * 没有接收侧，因此不涉及 getupdates 与上下文游标。
 */

/* ============================ 常量 ============================ */

export const TICKET_SECONDS = 5 * 60;
export const MAX_TEXT_LENGTH = 4000;

/**
 * 上游表示「bot 令牌已失活 / 会话超时」的错误码。
 * 命中它说明这个绑定已经作废，重试无意义，需要重新扫码。
 */
export const STALE_TOKEN_ERRCODE = -14;

/** 二维码登录的固定入口；服务端可能返回区域节点，由 pollQr 的 redirect 处理。 */
const ILINK_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com/";

/**
 * 上游超时。注意 get_qrcode_status 是**长轮询**：
 * 实测会挂起约 18 秒才返回，因此这里的值必须明显大于挂起时长，
 * 否则每轮都会被我们自己掐断。
 */
const QR_TIMEOUT_MS = 40_000;
const QR_START_TIMEOUT_MS = 15_000;

const SEND_TIMEOUT_MS = 15_000;

/** 长轮询重试预算：单次调用内允许的额外重试次数与间隔。 */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_QR_RESPONSE_BYTES = 16 * 1024;

/**
 * 属于「这一轮没拿到数据」的瞬时错误，值得重试。
 *
 * 只包含传输层故障（超时、连不上）。上游明确返回的业务错误是确定性拒绝，
 * 重试无意义，用独立错误码区分。
 */
const RETRYABLE_ERRORS = new Set([
  "weixin_upstream_timeout",
  "weixin_upstream_unreachable",
  "weixin_qr_poll_failed",
]);

/** 上游返回的扫码状态中，原样透传给前端的那些。 */
const PASSTHROUGH_QR_STATUSES = new Set([
  "wait",
  "scaned",
  "need_verifycode",
  "verify_code_blocked",
  "expired",
  "binded_redirect",
]);

/* ======================= 一、基础工具 ======================= */

const encoder = new TextEncoder();

/** 生成 URL 安全的随机令牌。 */
export function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * 常量时间字符串比对。长度不同也走完整循环，避免时序侧信道。
 * 任一侧为空视为不通过。
 */
export function tokenMatches(supplied, expected) {
  if (typeof supplied !== "string" || !supplied) return false;
  if (typeof expected !== "string" || !expected) return false;
  const a = encoder.encode(supplied);
  const b = encoder.encode(expected);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{16,256})$/u;

/** 从 Authorization 头取出 Bearer 令牌；格式不符返回 null。 */
export function readBearerToken(authorizationHeader) {
  const match = BEARER_RE.exec(authorizationHeader || "");
  return match ? match[1] : null;
}

/** 校验文本通知的有效性。返回规范化文本，或抛出带 code 的错误。 */
export function normalizeText(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("text_required");
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) throw new Error("text_too_long");
  return text;
}

/** 校验并规范化验证码；undefined 表示本次不带验证码。 */
export function normalizeVerifyCode(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,12}$/u.test(value)) throw new Error("invalid_verify_code");
  return value;
}

/* ======================= 二、票据签名 ======================= */

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * 创建票据签名器。票据是无状态 HMAC 签名串，用于把二维码上下文
 * 在多次轮询之间传递，服务端无需保存会话。
 *
 * 密钥来源由调用方决定：传 `secret` 用固定值，传 `provideSecret` 用异步自举
 * （例如从 KV 读取、缺失时生成）。两者取其一，后者优先。
 *
 * 调用方只需：seal(payload) 签发、open(token) 验签并取回 payload。
 */
export function createTicketSigner({ secret, provideSecret } = {}) {
  const fixed = typeof secret === "string" && secret.length >= 16 ? secret : null;
  if (!fixed && typeof provideSecret !== "function") {
    throw new Error("ticket_secret_not_configured");
  }

  // 配了固定密钥就用它，否则走异步自举（例如从 KV 取、缺失时生成）。
  const loader = fixed ? async () => fixed : provideSecret;

  let cachedKey = null;

  async function signKey() {
    if (cachedKey) return cachedKey;
    const material = await loader();
    if (typeof material !== "string" || material.length < 16) {
      throw new Error("ticket_secret_not_configured");
    }
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`weixin-webhook-ticket:${material}`));
    cachedKey = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return cachedKey;
  }

  return {
    async seal(payload) {
      const issuedAt = Number.isSafeInteger(payload?.iat) ? payload.iat : Math.floor(Date.now() / 1000);
      const now = Math.floor(Date.now() / 1000);
      const ticket = {
        ...payload,
        iat: issuedAt,
        exp: Number.isSafeInteger(payload?.exp) ? payload.exp : issuedAt + TICKET_SECONDS,
      };
      if (ticket.exp - ticket.iat > TICKET_SECONDS || ticket.exp <= now) throw new Error("invalid_qr_ticket");
      const body = toBase64Url(encoder.encode(JSON.stringify(ticket)));
      const signature = await crypto.subtle.sign("HMAC", await signKey(), encoder.encode(body));
      return `${body}.${toBase64Url(new Uint8Array(signature))}`;
    },

    async open(token) {
      if (typeof token !== "string" || token.length > 12_000) return null;
      const parts = token.split(".");
      if (parts.length !== 2) return null;

      // 自举密钥可能来自最终一致的存储，缓存值未必是签发时用的值。
      // 首次验签失败时丢弃缓存重取一次，可消除这类偶发不一致。
      const attempts = fixed ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const valid = await crypto.subtle.verify(
            "HMAC",
            await signKey(),
            fromBase64Url(parts[1]),
            encoder.encode(parts[0]),
          );
          if (!valid) {
            if (attempt + 1 < attempts) {
              cachedKey = null; // 强制下一轮重取密钥
              continue;
            }
            return null;
          }
          const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
          const now = Math.floor(Date.now() / 1000);
          if (!payload || !Number.isSafeInteger(payload.exp) || payload.exp <= now) return null;
          if (!Number.isSafeInteger(payload.iat) || payload.iat > now + 60) return null;
          if (payload.exp - payload.iat > TICKET_SECONDS) return null;
          return payload;
        } catch {
          cachedKey = null;
          if (attempt + 1 >= attempts) return null;
        }
      }
      return null;
    },
  };
}

/* ==================== 三、iLink 协议调用 ==================== */

/**
 * 归一化上游的业务返回码。
 *
 * 协议里 `ret` 是每类响应都有的状态码（`0` 表示成功），`errcode` 是
 * 「可选的应用错误码」（协议「返回值和错误」一节）。两者任一非 0 都算失败，
 * 取第一个非 0 的值；判断只依据这两个字段本身。
 */
function upstreamErrorCode(result) {
  for (const key of ["errcode", "ret"]) {
    const value = Number(result?.[key]);
    if (Number.isInteger(value) && value !== 0) return value;
  }
  return 0;
}

/**
 * 把上游响应里属于协议本身的字段**原样搬运**：不改名、不补默认值、不翻译。
 * 上游没说的事，我们不替它说；上游说了的事，我们一个字都不动。
 *
 * 只取协议里定义的那三个：`ret`（状态码，`0` 表示成功）、`errcode`
 * （可选的应用错误码）、`errmsg`（可选的错误描述）。
 */
function upstreamFields(result) {
  const picked = {};
  for (const key of ["ret", "errcode", "errmsg"]) {
    if (result?.[key] !== undefined) picked[key] = result[key];
  }
  return picked;
}

function encodedClientVersion(version) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(version);
  if (!match) throw new Error("invalid_channel_version");
  const [major, minor, patch] = match.slice(1).map(Number);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("invalid_weixin_base_url");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_weixin_base_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_weixin_base_url");
  }
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("invalid_weixin_base_url");
  return url.origin + "/";
}

function normalizeRedirectHost(value) {
  if (typeof value !== "string" || value.length > 253 || !/^[A-Za-z0-9.-]+$/u.test(value)) {
    throw new Error("invalid_weixin_redirect_host");
  }
  const url = new URL(`https://${value}`);
  if (url.hostname !== value.toLowerCase() || !url.hostname.includes(".")) {
    throw new Error("invalid_weixin_redirect_host");
  }
  return url.origin + "/";
}

/**
 * 创建 iLink 客户端。HTTP 能力由调用方注入，便于在任意运行时组合测试。
 *
 * 调用方只需知道：
 *   startQr(tokens)            → { qrcode, qrcodeImgContent, baseUrl }
 *   pollQr({ qrcode, baseUrl, verifyCode }) → { status, baseUrl?, account? }
 *   sendText(account, text)    → 上游字段（ret / errcode / errmsg 原样）
 */
export function createIlink({ fetch: fetchImpl, channelVersion = "2.4.9", appId = "bot" }) {
  if (typeof fetchImpl !== "function") throw new Error("fetch_not_injected");

  function commonHeaders() {
    return {
      "iLink-App-Id": appId,
      "iLink-App-ClientVersion": encodedClientVersion(channelVersion),
    };
  }

  function requestHeaders({ token, json = false } = {}) {
    const randomUin = crypto.getRandomValues(new Uint32Array(1))[0];
    const headers = {
      ...commonHeaders(),
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": btoa(String(randomUin)),
    };
    if (json) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function baseInfo() {
    return { channel_version: channelVersion, bot_agent: "OpenClaw" };
  }

  async function readJsonFrom(response, maxBytes) {
    const contentLength = Number(response.headers.get("Content-Length") || 0);
    if (contentLength > maxBytes) throw new Error("weixin_response_too_large");
    const raw = await response.text();
    if (encoder.encode(raw).byteLength > maxBytes) throw new Error("weixin_response_too_large");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("invalid_weixin_response");
    }
  }

  async function request(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // iLink 可能把请求重定向到区域节点，腾讯插件依赖 fetch 的默认重定向行为。
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError" || error?.cause?.name === "TimeoutError") {
        throw new Error("weixin_upstream_timeout", { cause: error });
      }
      throw new Error("weixin_upstream_unreachable", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 长轮询专用：瞬时失败时按预算重试，耗尽才把错误抛出去。
   *
   * 长轮询本来就会周期性「没等到数据」，把它当致命错误会让调用方无故中断，
   * 所以统一在这里兜住。确定性错误原样抛出，不做无意义重试。
   */
  async function withRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!RETRYABLE_ERRORS.has(error?.message) || attempt + 1 >= RETRY_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    throw lastError;
  }

  async function startQr(existingTokens = []) {
    let response;
    try {
      const url = new URL("ilink/bot/get_bot_qrcode?bot_type=3", ILINK_LOGIN_BASE_URL);
      response = await request(
        url,
        {
          method: "POST",
          headers: requestHeaders({ json: true }),
          body: JSON.stringify({ local_token_list: existingTokens.slice(0, 10) }),
        },
        QR_START_TIMEOUT_MS,
      );
    } catch (error) {
      if (error?.message === "weixin_upstream_timeout" || error?.message === "weixin_upstream_unreachable") {
        throw error;
      }
      throw new Error("weixin_qr_start_failed");
    }
    if (!response.ok) throw new Error(`weixin_qr_upstream_http_${response.status}`);
    const result = await readJsonFrom(response, MAX_QR_RESPONSE_BYTES);
    if (typeof result.qrcode !== "string" || result.qrcode.length > 4096) throw new Error("invalid_weixin_qr_response");
    if (typeof result.qrcode_img_content !== "string" || result.qrcode_img_content.length > 8192) {
      throw new Error("invalid_weixin_qr_response");
    }
    return {
      qrcode: result.qrcode,
      qrcodeImgContent: result.qrcode_img_content,
      baseUrl: ILINK_LOGIN_BASE_URL,
    };
  }

  async function pollQr({ qrcode, baseUrl, verifyCode }) {
    if (typeof qrcode !== "string" || !qrcode || qrcode.length > 4096) throw new Error("invalid_qr_ticket");
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const code = normalizeVerifyCode(verifyCode);

    const url = new URL("ilink/bot/get_qrcode_status", normalizedBaseUrl);
    url.searchParams.set("qrcode", qrcode);
    if (code) url.searchParams.set("verify_code", code);

    // 长轮询：让它在内部把瞬时失败消化掉，调用方只需反复问「什么状态了」。
    let response;
    let result;
    await withRetry(async () => {
      response = await request(url, { method: "GET", headers: commonHeaders() }, QR_TIMEOUT_MS);
      if (!response.ok) throw new Error("weixin_qr_poll_failed");
      result = await readJsonFrom(response, MAX_QR_RESPONSE_BYTES);
    });
    const status = result.status;

    if (status === "scaned_but_redirect") {
      return {
        status: "redirect",
        baseUrl: result.redirect_host ? normalizeRedirectHost(result.redirect_host) : normalizedBaseUrl,
      };
    }
    if (status === "confirmed") {
      if (typeof result.bot_token !== "string" || result.bot_token.length > 4096) {
        throw new Error("invalid_weixin_login_response");
      }
      if (typeof result.ilink_bot_id !== "string" || result.ilink_bot_id.length > 512) {
        throw new Error("invalid_weixin_login_response");
      }
      if (typeof result.ilink_user_id !== "string" || result.ilink_user_id.length > 512) {
        throw new Error("invalid_weixin_login_response");
      }
      return {
        status: "confirmed",
        account: {
          botToken: result.bot_token,
          botId: result.ilink_bot_id,
          baseUrl: normalizeBaseUrl(result.baseurl),
          scannerUserId: result.ilink_user_id,
        },
      };
    }
    return { status: PASSTHROUGH_QR_STATUSES.has(status) ? status : "unknown" };
  }

  /**
   * 发送一条文本消息，返回上游响应里的协议字段（`ret` / `errcode` / `errmsg`）。
   *
   * 请求体只放协议要求的字段，`context_token` 不在其列：它是「回复某条会话」时
   * 才需要回带的关联字段，而本服务是单向推送、不接收消息，因此永远省略。
   * 协议里它是可选的，省略合法。
   *
   * **成功与否只看协议字段**：`ret` / `errcode` 非 0，或 `errmsg` 非空
   * （协议称其为「可选的错误描述」，成功示例里它是空串），都算没成功。
   * 不引入协议之外的经验判据——上游给什么，我们就如实转述什么。
   *
   * 失败时把上游的 HTTP 状态与响应字段一并挂到错误对象上：这一层不吞、不翻译、
   * 不替上游下结论，把「到底怎么回事」完整交给调用方。
   */
  async function sendText(account, text) {
    const baseUrl = normalizeBaseUrl(account.baseUrl);
    if (typeof account.botToken !== "string" || !account.botToken || !account.recipient) {
      throw new Error("account_send_not_configured");
    }

    const endpoint = new URL("ilink/bot/sendmessage", baseUrl);
    const response = await request(
      endpoint,
      {
        method: "POST",
        headers: requestHeaders({ token: account.botToken, json: true }),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: account.recipient,
            client_id: crypto.randomUUID(),
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: baseInfo(),
        }),
      },
      SEND_TIMEOUT_MS,
    );

    const result = await readJsonFrom(response, MAX_RESPONSE_BYTES);
    const fields = upstreamFields(result);
    const code = upstreamErrorCode(result);
    const errmsg = typeof result.errmsg === "string" ? result.errmsg.trim() : "";

    /** 组装失败错误：上游原话 + HTTP 状态，字段名一个都不改。 */
    function failure(name) {
      const error = new Error(name);
      error.upstreamStatus = response.status;
      error.upstream = { ...fields };
      // 上游把码放哪个字段并不固定，两个都空时用归一化后的值兜底，
      // 好让调用方至少知道「它确实报了错」。
      if (error.upstream.ret === undefined && error.upstream.errcode === undefined && code !== 0) {
        error.upstream.ret = code;
      }
      return error;
    }

    if (!response.ok || code !== 0) {
      throw failure(code === STALE_TOKEN_ERRCODE ? "weixin_bot_token_stale" : "weixin_send_failed");
    }
    // ret = 0 但上游写了错误描述：它嘴上说成功，实际给了反对意见，同样不算成功。
    if (errmsg) throw failure("weixin_send_failed");

    return fields;
  }

  return { startQr, pollQr, sendText };
}

/* ==================== 四、账号记录 ==================== */

/** 生成一条新的账号记录（扫码确认后调用）。 */
export function createAccount(loginResult, { notifyToken, createdAt = Date.now() } = {}) {
  return {
    botToken: loginResult.botToken,
    botId: loginResult.botId,
    baseUrl: loginResult.baseUrl,
    recipient: loginResult.scannerUserId,
    notifyToken,
    createdAt,
  };
}
