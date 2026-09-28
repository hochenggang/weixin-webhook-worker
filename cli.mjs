/**
 * 本地测试入口：不依赖 Cloudflare，直接在 Node 里跑完整链路。
 *
 * 复用 src/common.js 的同一份逻辑，因此本地验证过的行为与 Worker 一致。
 * 凭证保存在本地文件 .local-session.json（已在 .gitignore 中）。
 *
 * 用法：
 *   node cli.mjs login     扫码连接，把凭证存到本地
 *   node cli.mjs status    查看当前连接状态
 *   node cli.mjs send <文本>   发送一条通知
 *   node cli.mjs logout    删除本地凭证（想重新扫码就执行这个）
 */

import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode-svg";

import {
  accountChanged,
  applyUpdates,
  createAccount,
  createIlink,
  createTicketSigner,
  invalidateContext,
  normalizeText,
  randomToken,
  TICKET_SECONDS,
} from "./src/common.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(ROOT, ".local-session.json");
const POLL_INTERVAL_MS = 500;

/* ============================ 终端着色 ============================ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const deep = (text) => paint("38;5;35", text);
const mid = (text) => paint("38;5;108", text);
const dim = (text) => paint("2", text);
const bad = (text) => paint("38;5;167", text);
const bold = (text) => paint("1", text);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================ 本地存储 ============================ */

async function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const session = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    return session && typeof session.botToken === "string" ? session : null;
  } catch {
    console.error(bad("本地凭证文件无法解析，请执行 logout 后重新 login。"));
    process.exit(1);
  }
}

async function saveSession(session) {
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

/**
 * 基于本地账号状态与一轮上游消息，算出新状态。
 * 与 Worker 里的持久化策略共用同一套纯函数。
 */
function advanceSession(session, updates) {
  return applyUpdates(session, updates);
}

/* ============================ 远端交互 ============================ */

function makeIlink() {
  return createIlink({
    fetch,
    channelVersion: process.env.WEIXIN_CHANNEL_VERSION || "2.4.9",
    appId: process.env.WEIXIN_APP_ID || "bot",
  });
}

/** 拉取一轮增量消息并写回本地文件；用于补齐 contextToken。 */
async function refreshContext(ilink, session, { label = "" } = {}) {
  const updates = await ilink.pullUpdates(session);
  const next = advanceSession(session, updates);
  if (accountChanged(session, next)) await saveSession(next);
  if (label) {
    console.log(dim(`  ${label}：游标 ${next.getUpdatesBuf || "(空)"}，上下文 ${next.contextToken ? "已获取" : "仍为空"}`));
  }
  return next;
}

/** 发送文本。上下文失效时按 Worker 相同策略重置游标并重试一次。 */
async function deliver(ilink, session, text) {
  let current = session;

  if (!current.contextToken) {
    console.log(dim("  上下文为空，正在向微信拉取…"));
    current = await refreshContext(ilink, session, { label: "拉取结果" });
  }

  try {
    return { session: current, result: await ilink.sendText(current, text) };
  } catch (error) {
    if (error?.message !== "weixin_send_failed" || error.upstreamRet !== -2) throw error;

    console.log(dim("  上下文已失效，重置游标后重新拉取…"));
    const reset = invalidateContext(current);
    await saveSession(reset);
    const refreshed = await refreshContext(ilink, reset, { label: "重新拉取" });
    if (!refreshed.contextToken) throw new Error("weixin_context_missing");
    return { session: refreshed, result: await ilink.sendText(refreshed, text) };
  }
}

/* ============================ 二维码渲染 ============================ */

/** 终端二维码：模块边长（配合半块字符实现近似正方形）。 */
const QR_TARGET_SIZE = 480;

/**
 * 用 qrcode-svg 生成二维码（与 Worker 侧同一实现），再还原成矩阵，
 * 以便在终端用半块字符绘制。避免维护第二份编码器。
 */
function buildMatrix(text) {
  let svg;
  try {
    svg = new QRCode({
      content: text,
      padding: 0,
      width: QR_TARGET_SIZE,
      height: QR_TARGET_SIZE,
      color: "#000000",
      background: "#ffffff",
      ecl: "M",
      join: true,
      container: "svg-viewbox",
      xmlDeclaration: false,
    }).svg();
  } catch {
    return null;
  }

  // qrcode-svg 每个方块形如 `M{x},{y} V{y2} H{x2} V{y} H{x} Z`（绝对坐标，空格分隔）。
  const blocks = [...svg.matchAll(/M([\d.]+),([\d.]+) V([\d.]+) H([\d.]+) V[\d.]+ H[\d.]+ Z/gu)];
  if (!blocks.length) return null;

  // 用最小边长反推模块尺寸（同色连片会合并成大方块，故取最小者最可靠）。
  const step = Math.min(
    ...blocks.map(([, x, y, y2, x2]) =>
      Math.min(Number(y2) - Number(y), Number(x2) - Number(x)),
    ),
  );
  if (!(step > 0)) return null;
  const size = Math.round(QR_TARGET_SIZE / step);
  if (size < 21 || size > 177) return null;

  const modules = new Uint8Array(size * size);
  for (const [, x, y, y2, x2] of blocks) {
    const col = Math.round(Number(x) / step);
    const row = Math.round(Number(y) / step);
    const spanX = Math.max(1, Math.round((Number(x2) - Number(x)) / step));
    const spanY = Math.max(1, Math.round((Number(y2) - Number(y)) / step));
    for (let dy = 0; dy < spanY; dy += 1) {
      for (let dx = 0; dx < spanX; dx += 1) {
        const px = col + dx;
        const py = row + dy;
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        modules[py * size + px] = 1;
      }
    }
  }

  // 空矩阵说明解析没命中，退回不可渲染。
  if (!modules.some((value) => value === 1)) return null;
  return { size, modules };
}

/** 用半块字符绘制二维码，终端里上下两格合成一个字符。 */
function renderQr(text) {
  const qr = buildMatrix(text);
  if (!qr) return null;

  const { size, modules } = qr;
  const quiet = 2;
  const lines = [];

  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = "";
    for (let x = -quiet; x < size + quiet; x += 1) {
      const top = moduleAt(modules, size, x, y);
      const bottom = moduleAt(modules, size, x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function moduleAt(modules, size, x, y) {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  return modules[y * size + x];
}


/* ============================ 子命令 ============================ */

async function cmdLogin() {
  const ilink = makeIlink();
  console.log(bold("\n微信通知转接 · 本地连接\n"));

  const existing = await loadSession();
  if (existing) {
    console.log(mid(`本地已保存连接（默认收件人 ${existing.recipient}）。`));
    console.log(dim("如需重新连接，请先执行：node cli.mjs logout\n"));
    return;
  }

  console.log(dim("正在向微信申请二维码…"));
  const signer = createTicketSigner({ secret: randomToken(32) });
  const qr = await ilink.startQr([]);

  const rendered = renderQr(qr.qrcodeImgContent);
  console.log();
  if (rendered) {
    console.log(rendered);
  } else {
    console.log(mid("（终端二维码渲染不可用，请复制下面内容生成二维码）"));
    console.log(dim(qr.qrcodeImgContent));
  }
  console.log("\n" + deep("请用手机微信扫描上方二维码。") + dim("  等待中…\n"));

  const deadline = Date.now() + TICKET_SECONDS * 1000;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let verifyCode;
  let confirmed = null;

  try {
    while (Date.now() < deadline) {
      // pollQr 是长轮询，且内部已对「超时/网络抖动」自动重试，
      // 所以这里只需要处理业务状态，不必再自己兜错误。
      const result = await ilink.pollQr({
        qrcode: qr.qrcode,
        baseUrl: qr.baseUrl,
        verifyCode,
      });
      verifyCode = undefined;

      if (result.status === "confirmed") {
        confirmed = result.account;
        break;
      }
      if (result.status === "need_verifycode") {
        const answer = await rl.question(mid("请输入微信显示的数字验证码："));
        verifyCode = answer.trim();
        continue;
      }
      if (result.status === "expired") {
        console.error(bad("\n二维码已过期，请重新执行 login。"));
        process.exit(1);
      }
      if (result.status === "binded_redirect") {
        console.error(bad("\n该微信账号已绑定其他实例，微信未返回新的连接凭证。"));
        process.exit(1);
      }
      if (result.status === "verify_code_blocked") {
        console.error(bad("\n验证码多次错误，微信暂时阻止了本次连接，请稍后重试。"));
        process.exit(1);
      }
      if (result.status === "unknown") {
        console.error(bad("\n收到未知的登录状态，请重新执行 login。"));
        process.exit(1);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    rl.close();
  }

  if (!confirmed) {
    console.error(bad("\n等待扫码超时，请重新执行 login。"));
    process.exit(1);
  }

  const session = createAccount(confirmed, { notifyToken: randomToken() });
  await saveSession(session);

  console.log(deep("\n连接成功。"));
  console.log(dim(`  凭证已保存到 ${SESSION_FILE}`));
  console.log(dim(`  默认收件人：${session.recipient}\n`));
  console.log(mid("下一步：让该收件人给这个微信账号发一条消息，然后执行"));
  console.log("  " + bold("node cli.mjs send \"这是一条测试通知\"") + "\n");
}

async function cmdStatus() {
  const session = await loadSession();
  if (!session) {
    console.log(mid("\n本地尚未连接。执行 node cli.mjs login 开始扫码。\n"));
    return;
  }
  console.log(bold("\n当前连接\n"));
  console.log(`  默认收件人   ${session.recipient}`);
  console.log(`  机器人 ID    ${session.botId}`);
  console.log(`  登录节点     ${session.baseUrl}`);
  console.log(`  消息游标     ${session.getUpdatesBuf || dim("(空)")}`);
  console.log(`  上下文令牌   ${session.contextToken ? deep("已获取") : mid("尚未获取")}`);
  console.log();
  if (!session.contextToken) {
    console.log(dim("  上下文尚未获取：请让收件人先给这个微信账号发一条消息。\n"));
  }
}

async function cmdSend(text) {
  if (!text) {
    console.error(bad("\n用法：node cli.mjs send \"要发送的文本\"\n"));
    process.exit(1);
  }
  let normalized;
  try {
    normalized = normalizeText(text);
  } catch (error) {
    console.error(bad(`\n文本不合法：${error.message}\n`));
    process.exit(1);
  }

  const session = await loadSession();
  if (!session) {
    console.error(bad("\n本地尚未连接。请先执行 node cli.mjs login。\n"));
    process.exit(1);
  }

  const ilink = makeIlink();
  console.log(bold("\n发送通知\n"));
  try {
    const { result } = await deliver(ilink, session, normalized);
    console.log(deep(`\n已发送。messageId = ${result.messageId}\n`));
  } catch (error) {
    const code = error?.message || "internal_error";
    if (code === "weixin_context_missing") {
      console.error(mid("\n还没有该收件人的会话上下文。"));
      console.error(dim("请让收件人先给这个微信账号发一条消息，然后重试。\n"));
      process.exit(1);
    }
    const extra = [
      error.upstreamStatus ? `status=${error.upstreamStatus}` : "",
      error.upstreamRet !== undefined ? `ret=${error.upstreamRet}` : "",
      error.upstreamErrcode !== undefined ? `errcode=${error.upstreamErrcode}` : "",
    ].filter(Boolean).join(" ");
    console.error(bad(`\n发送失败：${code}${extra ? " (" + extra + ")" : ""}\n`));
    process.exit(1);
  }
}

async function cmdLogout() {
  if (existsSync(SESSION_FILE)) {
    await unlink(SESSION_FILE);
    console.log(mid("\n已删除本地凭证。\n"));
  } else {
    console.log(mid("\n本地没有凭证文件。\n"));
  }
}

function printUsage() {
  console.log(`
${bold("微信通知转接 · 本地测试")}

  node cli.mjs login           扫码连接，凭证保存到本地
  node cli.mjs status          查看当前连接状态
  node cli.mjs send <文本>      发送一条通知
  node cli.mjs logout          删除本地凭证（想重新扫码就执行这个）

${dim("凭证文件 .local-session.json 仅供本地开发，不会上传到任何地方。")}
${dim("重新扫码：先 logout 清掉本地凭证，再 login。")}
`);
}

/* ============================ 入口 ============================ */

const [command, ...rest] = process.argv.slice(2);

const commands = {
  login: cmdLogin,
  status: cmdStatus,
  send: () => cmdSend(rest.join(" ")),
  logout: cmdLogout,
};

const handler = commands[command];
if (!handler) {
  printUsage();
  process.exit(command ? 1 : 0);
}

try {
  await handler();
} catch (error) {
  const code = error?.message || "internal_error";
  if (/^[a-z0-9_]{1,64}$/u.test(code)) {
    console.error(bad(`\n操作失败：${code}\n`));
  } else {
    console.error(bad(`\n操作失败：${error.message}\n`));
  }
  process.exit(1);
}
