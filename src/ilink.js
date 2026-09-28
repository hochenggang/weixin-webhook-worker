const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com/";
const QR_TIMEOUT_MS = 20_000;
const UPDATES_TIMEOUT_MS = 45_000;
const SEND_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024;

function encodedClientVersion(version) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(version);
  if (!match) throw new Error("invalid_channel_version");
  const [major, minor, patch] = match.slice(1).map(Number);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

function commonHeaders(env) {
  const version = env.WEIXIN_CHANNEL_VERSION || "2.4.9";
  return {
    "iLink-App-Id": env.WEIXIN_APP_ID || "bot",
    "iLink-App-ClientVersion": encodedClientVersion(version),
  };
}

function requestHeaders(env, { token, json = false } = {}) {
  const randomUin = crypto.getRandomValues(new Uint32Array(1))[0];
  const headers = {
    ...commonHeaders(env),
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": btoa(String(randomUin)),
  };
  if (json) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > maxBytes) throw new Error("weixin_response_too_large");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("weixin_response_too_large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_weixin_response");
  }
}

function baseInfo(env) {
  return {
    channel_version: env.WEIXIN_CHANNEL_VERSION || "2.4.9",
    bot_agent: "OpenClaw",
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // iLink may redirect requests to a regional endpoint. The Tencent plugin
    // uses fetch's default redirect behavior, so keep that behavior here too.
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" || error?.cause?.name === "TimeoutError") {
      throw new Error("weixin_upstream_timeout", { cause: error });
    }
    throw new Error("weixin_upstream_unreachable", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
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

export async function startQrLogin(existingTokens, env) {
  let response;
  try {
    const url = new URL("ilink/bot/get_bot_qrcode?bot_type=3", LOGIN_BASE_URL);
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: requestHeaders(env, { json: true }),
        body: JSON.stringify({ local_token_list: existingTokens.slice(0, 10) }),
      },
      15_000,
    );
  } catch (error) {
    if (error?.message === "weixin_upstream_timeout" || error?.message === "weixin_upstream_unreachable") {
      throw error;
    }
    throw new Error("weixin_qr_start_failed");
  }
  if (!response.ok) throw new Error(`weixin_qr_upstream_http_${response.status}`);
  const result = await readJson(response, 16 * 1024);
  if (typeof result.qrcode !== "string" || result.qrcode.length > 4096) {
    throw new Error("invalid_weixin_qr_response");
  }
  if (typeof result.qrcode_img_content !== "string" || result.qrcode_img_content.length > 8192) {
    throw new Error("invalid_weixin_qr_response");
  }
  return {
    qrcode: result.qrcode,
    qrcodeImgContent: result.qrcode_img_content,
    baseUrl: LOGIN_BASE_URL,
  };
}

export async function pollQrLogin({ qrcode, baseUrl, verifyCode }, env) {
  if (typeof qrcode !== "string" || !qrcode || qrcode.length > 4096) throw new Error("invalid_qr_ticket");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (verifyCode !== undefined && (typeof verifyCode !== "string" || !/^\d{1,12}$/u.test(verifyCode))) {
    throw new Error("invalid_verify_code");
  }
  const url = new URL("ilink/bot/get_qrcode_status", normalizedBaseUrl);
  url.searchParams.set("qrcode", qrcode);
  if (verifyCode) url.searchParams.set("verify_code", verifyCode);
  const response = await fetchWithTimeout(
    url,
    { method: "GET", headers: commonHeaders(env) },
    QR_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error("weixin_qr_poll_failed");
  const result = await readJson(response, 16 * 1024);
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
  const supported = new Set([
    "wait",
    "scaned",
    "need_verifycode",
    "verify_code_blocked",
    "expired",
    "binded_redirect",
  ]);
  return { status: supported.has(status) ? status : "unknown" };
}

export async function pollUpdates(account, env) {
  const baseUrl = normalizeBaseUrl(account.baseUrl);
  if (typeof account.botToken !== "string" || !account.botToken) {
    throw new Error("account_send_not_configured");
  }
  const endpoint = new URL("ilink/bot/getupdates", baseUrl);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: requestHeaders(env, { token: account.botToken, json: true }),
      body: JSON.stringify({
        get_updates_buf: typeof account.getUpdatesBuf === "string" ? account.getUpdatesBuf : "",
        base_info: baseInfo(env),
      }),
    },
    UPDATES_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error("weixin_updates_failed");
  const result = await readJson(response, 256 * 1024);
  if (result.ret !== undefined && result.ret !== 0) throw new Error("weixin_updates_failed");
  if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw new Error("invalid_weixin_updates_response");
  if (result.get_updates_buf !== undefined && (typeof result.get_updates_buf !== "string" || result.get_updates_buf.length > 16_384)) {
    throw new Error("invalid_weixin_updates_response");
  }
  return {
    getUpdatesBuf: typeof result.get_updates_buf === "string" ? result.get_updates_buf : account.getUpdatesBuf || "",
    messages: (result.msgs || []).slice(-200),
  };
}

export async function sendText(account, text, env) {
  const baseUrl = normalizeBaseUrl(account.baseUrl);
  if (typeof account.botToken !== "string" || !account.botToken || !account.defaultRecipient) {
    throw new Error("account_send_not_configured");
  }
  if (typeof account.contextToken !== "string" || !account.contextToken) {
    throw new Error("weixin_context_missing");
  }
  const endpoint = new URL("ilink/bot/sendmessage", baseUrl);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: requestHeaders(env, { token: account.botToken, json: true }),
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: account.defaultRecipient,
          client_id: crypto.randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: account.contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: baseInfo(env),
      }),
    },
    SEND_TIMEOUT_MS,
  );
  const result = await readJson(response);
  if (!response.ok || (result.ret !== undefined && result.ret !== 0)) {
    const error = new Error("weixin_send_failed");
    error.upstreamStatus = response.status;
    if (Number.isInteger(result.ret)) error.upstreamRet = result.ret;
    if (Number.isInteger(result.errcode)) error.upstreamErrcode = result.errcode;
    throw error;
  }
  return { messageId: typeof result.message_id === "string" ? result.message_id : null };
}
