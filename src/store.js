/**
 * 单账号 KV 存储。整条账号记录以明文 JSON 保存。
 *
 * 只有两个 key：account（账号状态）、signing-secret（自举的签名密钥）。
 */

const KEY = "account";
const SECRET_KEY = "signing-secret";

function store(env) {
  if (!env.WEIXIN_KV || typeof env.WEIXIN_KV.get !== "function") {
    throw new Error("account_store_unavailable");
  }
  return env.WEIXIN_KV;
}

export async function getAccount(env) {
  const raw = await store(env).get(KEY);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const account = JSON.parse(raw);
    return account && typeof account.botToken === "string" ? account : null;
  } catch {
    throw new Error("account_record_unreadable");
  }
}

export async function putAccount(env, account) {
  if (!account || typeof account.botToken !== "string") throw new Error("invalid_account_record");
  // 不改入参：调用方拿到的账号对象保持原样。
  await store(env).put(KEY, JSON.stringify({ ...account, updatedAt: Date.now() }));
}

/**
 * 取回签名密钥；不存在则生成一个并落库。
 *
 * 这是「零配置」的关键：部署者不需要填写任何 secret，Worker 首次需要时
 * 自行生成。极端并发下可能有两个实例各生成一个，后者覆盖前者，
 * 此时先签发的那张票据会验签失败——调用方重试取二维码即可，影响可忽略。
 */
export async function getOrCreateSigningSecret(env, generate) {
  const existing = await store(env).get(SECRET_KEY);
  if (typeof existing === "string" && existing.length >= 16) return existing;

  const created = generate();
  await store(env).put(SECRET_KEY, created);
  return created;
}
