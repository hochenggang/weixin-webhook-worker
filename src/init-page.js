/**
 * 初始化页面。单文件：HTML + 内联样式 + 内联脚本，作为一个字符串导出。
 */

export const INIT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>微信通知转接 · 初始化</title>
<style>
  :root {
    --deep: #1a9d5e;
    --mid: #aad39c;
    --pale: #dce7dc;
    --ink: #1f2a24;
    --muted: #6b7d73;
    --paper: #ffffff;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 16px;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
  }

  .page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
  }

  .card {
    width: 100%;
    max-width: 620px;
    background: var(--paper);
    border: 10px solid var(--pale);
    border-radius: 6px;
    padding: 56px 52px 52px;
  }

  .eyebrow {
    font-size: 12px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 18px;
  }

  h1 {
    margin: 0 0 12px;
    font-size: 32px;
    line-height: 1.35;
    font-weight: 600;
    color: var(--deep);
    letter-spacing: 0.01em;
  }

  .lede {
    margin: 0 0 40px;
    color: var(--muted);
    font-size: 15px;
  }

  .stage { margin-bottom: 8px; }

  .qr-wrap {
    display: flex;
    justify-content: center;
    padding: 28px;
    border: 1px solid var(--mid);
    border-radius: 4px;
    background: var(--paper);
    min-height: 240px;
    align-items: center;
  }

  .qr-wrap svg {
    display: block;
    width: 240px;
    height: 240px;
  }

  .placeholder {
    color: var(--muted);
    font-size: 15px;
  }

  .status {
    margin: 26px 0 0;
    padding-left: 26px;
    position: relative;
    font-size: 15px;
    color: var(--muted);
    min-height: 26px;
  }

  .status::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--mid);
  }

  .status.live { color: var(--deep); }
  .status.live::before { background: var(--deep); }
  .status.bad { color: #b84747; }
  .status.bad::before { background: #b84747; }

  .verify {
    margin-top: 26px;
    display: flex;
    gap: 10px;
  }

  .verify input {
    flex: 1;
    padding: 13px 16px;
    font-size: 16px;
    font-family: inherit;
    color: var(--ink);
    border: 1px solid var(--mid);
    border-radius: 4px;
    outline: none;
  }

  .verify input:focus { border-color: var(--deep); }

  button {
    font-family: inherit;
    font-size: 15px;
    font-weight: 500;
    padding: 13px 26px;
    border-radius: 4px;
    border: 1px solid var(--deep);
    background: var(--deep);
    color: #fff;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  button:hover { opacity: 0.88; }
  button:disabled { opacity: 0.45; cursor: default; }

  button.ghost {
    background: var(--paper);
    color: var(--deep);
  }

  .done { display: none; }

  .done.show { display: block; }

  .done h2 {
    margin: 0 0 10px;
    font-size: 20px;
    font-weight: 600;
    color: var(--deep);
  }

  .done .hint {
    margin: 0 0 30px;
    color: var(--muted);
    font-size: 14px;
  }

  .warn {
    margin: 0 0 28px;
    padding: 16px 20px;
    border-left: 3px solid var(--deep);
    background: var(--pale);
    border-radius: 0 4px 4px 0;
    font-size: 14px;
    color: var(--ink);
  }

  .field { margin-bottom: 26px; }

  .field-label {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .field-row {
    display: flex;
    gap: 10px;
    align-items: stretch;
  }

  pre {
    flex: 1;
    margin: 0;
    padding: 18px 20px;
    background: var(--pale);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.75;
    color: var(--ink);
    overflow-x: auto;
    white-space: pre;
  }

  .field-row button { flex-shrink: 0; }

  .copy-note {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--muted);
    min-height: 20px;
  }

  .copy-note.ok { color: var(--deep); }
  .copy-note.bad { color: #b84747; }

  footer {
    margin-top: 44px;
    padding-top: 24px;
    border-top: 1px solid var(--pale);
    font-size: 13px;
    color: var(--muted);
  }

  a { color: var(--deep); text-decoration: none; }
  a:hover { text-decoration: underline; }

  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    padding: 1px 5px;
    background: var(--paper);
    border: 1px solid var(--mid);
    border-radius: 3px;
  }

  @media (max-width: 560px) {
    .card { padding: 36px 26px 32px; border-width: 8px; }
    h1 { font-size: 25px; }
    .field-row { flex-direction: column; }
    .field-row button { width: 100%; }
  }
</style>
</head>
<body>
<main class="page">
  <div class="card">

    <div id="setup">
      <div class="eyebrow">Weixin Relay</div>
      <h1>扫码连接你的微信</h1>
      <p class="lede">用手机微信扫描下方二维码完成绑定。绑定成功后，本页会给出调用方式。</p>

      <div class="stage">
        <div class="qr-wrap"><div id="qr" class="placeholder">正在向微信申请二维码…</div></div>
        <p id="status" class="status">正在向微信申请二维码…</p>
        <form id="verifyForm" class="verify" hidden>
          <input id="verifyCode" type="text" inputmode="numeric" autocomplete="off"
                 placeholder="请输入微信显示的数字验证码" maxlength="12">
          <button type="submit">提交</button>
        </form>
      </div>
    </div>

    <div id="done" class="done">
      <div class="eyebrow">Connected</div>
      <h2>连接成功</h2>
      <p class="hint">以下信息只在本页显示一次，离开后无法再次查看。</p>

      <div class="warn">
        请立即复制下方内容并妥善保存。<strong>刷新或关闭本页后，令牌将无法找回</strong>，
        届时需要到 Cloudflare 控制台的 KV 里删除 <code>account</code> 键，再重新扫码。
      </div>

      <div class="field">
        <div class="field-label">调用地址</div>
        <div class="field-row">
          <pre id="outEndpoint"></pre>
          <button type="button" class="ghost" data-copy="outEndpoint">复制</button>
        </div>
      </div>

      <div class="field">
        <div class="field-label">调用令牌</div>
        <div class="field-row">
          <pre id="outToken"></pre>
          <button type="button" class="ghost" data-copy="outToken">复制</button>
        </div>
      </div>

      <div class="field">
        <div class="field-label">完整调用示例</div>
        <div class="field-row">
          <pre id="outCurl"></pre>
          <button type="button" data-copy="outCurl">复制</button>
        </div>
        <p id="copyNote" class="copy-note"></p>
      </div>
    </div>

    <footer>
      收件人需要先给这个微信账号发一条消息，之后通知才能送达。
    </footer>

  </div>
</main>

<script>
(function () {
  var qrEl = document.getElementById("qr");
  var statusEl = document.getElementById("status");
  var verifyForm = document.getElementById("verifyForm");
  var verifyCode = document.getElementById("verifyCode");
  var setupEl = document.getElementById("setup");
  var doneEl = document.getElementById("done");

  var ticket = "";
  var expiresAt = 0;
  var pendingCode = "";
  var busy = false;
  var pollTimer = 0;

  var STATUS_TEXT = {
    wait: "等待手机微信扫码…",
    scaned: "已扫码，正在等待微信确认…",
    redirect: "微信正在切换登录节点…",
    need_verifycode: "请在微信中查看验证码并在此输入。",
    verify_code_blocked: "验证码多次错误，微信暂时阻止了本次连接。请刷新后重新扫码。",
    expired: "二维码已过期，请刷新页面重新生成。",
    binded_redirect: "这个微信账号已绑定其他实例，微信没有返回新的连接凭证。",
    unknown: "收到未知的登录状态，请刷新页面重试。"
  };

  var ERROR_TEXT = {
    weixin_upstream_unreachable: "无法连接微信服务，请稍后重试。",
    weixin_upstream_timeout: "连接微信服务超时，请稍后重试。",
    invalid_weixin_response: "微信服务返回了无法识别的响应。",
    weixin_qr_start_failed: "暂时无法向微信申请二维码，请刷新重试。",
    weixin_qr_poll_failed: "查询扫码状态失败，请稍后重试。",
    invalid_or_expired_qr_ticket: "二维码会话已过期，请刷新页面重新生成。",
    internal_error: "服务暂时不可用，请稍后重试。"
  };

  // 这些是长轮询里的正常波动，静默重试即可，不刷错误提示。
  var TRANSIENT_CODES = {
    weixin_upstream_timeout: 1,
    weixin_qr_poll_failed: 1
  };

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function errorText(code) {
    return ERROR_TEXT[code] || "操作失败，请刷新页面重试。";
  }

  function stopPolling() {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function schedulePoll(delay) {
    stopPolling();
    pollTimer = window.setTimeout(poll, delay);
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: "internal_error" };
      }).then(function (result) {
        if (!response.ok || result.ok === false) {
          var error = new Error(result.error || "internal_error");
          error.code = result.error || "internal_error";
          throw error;
        }
        return result;
      });
    });
  }

  function poll() {
    if (busy || !ticket) return;
    if (Date.now() >= expiresAt) {
      setStatus("二维码已过期，请刷新页面重新生成。", "bad");
      return;
    }
    busy = true;
    var body = { ticket: ticket };
    if (pendingCode) body.verifyCode = pendingCode;

    post("/api/init/poll", body).then(function (result) {
      busy = false;
      var status = result.status;

      if (status === "confirmed") {
        showResult(result);
        return;
      }
      if (status === "redirect") {
        if (result.ticket) ticket = result.ticket;
        setStatus(STATUS_TEXT.redirect);
        schedulePoll(400);
        return;
      }
      if (status === "need_verifycode") {
        pendingCode = "";
        verifyForm.hidden = false;
        verifyCode.focus();
        setStatus(STATUS_TEXT.need_verifycode);
        return;
      }
      if (status === "wait" || status === "scaned") {
        pendingCode = "";
        setStatus(STATUS_TEXT[status], status === "scaned" ? "live" : "");
        schedulePoll(400);
        return;
      }
      setStatus(STATUS_TEXT[status] || STATUS_TEXT.unknown, "bad");
    }).catch(function (error) {
      busy = false;
      if (error.code === "invalid_or_expired_qr_ticket") {
        setStatus(errorText(error.code), "bad");
        return;
      }
      // 长轮询超时是常态，静默重试即可，不必打扰用户。
      if (TRANSIENT_CODES[error.code]) {
        schedulePoll(300);
        return;
      }
      setStatus(errorText(error.code) + " 正在重试…");
      schedulePoll(2500);
    });
  }

  function showResult(result) {
    stopPolling();
    setupEl.style.display = "none";
    doneEl.classList.add("show");

    var account = result.account || {};
    var endpoint = result.endpoint || location.origin + "/notify";
    var token = result.notifyToken || "";

    document.getElementById("outEndpoint").textContent = endpoint;
    document.getElementById("outToken").textContent = token;
    document.getElementById("outCurl").textContent = result.curl ||
      ("curl -X POST " + endpoint + " \\\n" +
       "  -H \"Authorization: Bearer " + token + "\" \\\n" +
       "  -H \"Content-Type: application/json\" \\\n" +
       "  -d '{\"text\": \"这是一条微信通知\"}'");

    if (account.recipient) {
      var note = document.querySelector("footer");
      note.textContent = "当前默认收件人：" + account.recipient +
        "。若通知未送达，请让该收件人先给微信账号发一条消息。";
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (button) {
    button.addEventListener("click", function () {
      var source = document.getElementById(button.getAttribute("data-copy"));
      var note = document.getElementById("copyNote");
      var copy = navigator.clipboard
        ? navigator.clipboard.writeText(source.textContent)
        : Promise.reject(new Error("unsupported"));
      copy.then(function () {
        note.textContent = "已复制到剪贴板。";
        note.className = "copy-note ok";
      }).catch(function () {
        note.textContent = "复制失败，请手动选中上方文本复制。";
        note.className = "copy-note bad";
      });
    });
  });

  verifyForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var code = verifyCode.value.trim();
    if (!/^\\d{1,12}$/.test(code)) {
      setStatus("请输入微信显示的数字验证码。", "bad");
      return;
    }
    pendingCode = code;
    verifyCode.value = "";
    verifyForm.hidden = true;
    setStatus("正在验证…", "live");
    busy = false;
    poll();
  });

  post("/api/init/start", {}).then(function (result) {
    ticket = result.ticket;
    expiresAt = result.expiresAt;
    qrEl.className = "";
    qrEl.innerHTML = result.qrSvg;
    setStatus("请使用手机微信扫描二维码。", "live");
    schedulePoll(300);
  }).catch(function (error) {
    setStatus(errorText(error.code), "bad");
  });
})();
</script>
</body>
</html>`;
