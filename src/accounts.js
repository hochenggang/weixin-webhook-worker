import { decryptRecord, encryptRecord, hashSecret } from "./security.js";

const PREFIX = "account:";
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function store(env) {
  if (!env.WEIXIN_ACCOUNTS || typeof env.WEIXIN_ACCOUNTS.prepare !== "function") {
    throw new Error("account_store_unavailable");
  }
  return env.WEIXIN_ACCOUNTS;
}

export function makeAccountId() {
  return crypto.randomUUID();
}

async function storageKey(accountId) {
  return `${PREFIX}${await hashSecret(accountId)}`;
}

export async function getAccount(env, accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return null;
  const row = await store(env)
    .prepare("SELECT value FROM accounts WHERE key = ?")
    .bind(await storageKey(accountId))
    .first();
  if (!row || typeof row.value !== "string") return null;
  const account = await decryptRecord(row.value, env);
  return account.id === accountId ? account : null;
}

export async function listAccounts(env) {
  const { results = [] } = await store(env).prepare("SELECT value FROM accounts").all();
  const accounts = await Promise.all(results.map(({ value }) => decryptRecord(value, env)));
  return accounts.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
}

export async function putAccount(env, account) {
  if (!account || typeof account.id !== "string" || !ACCOUNT_ID.test(account.id)) {
    throw new Error("invalid_account_record");
  }
  await store(env)
    .prepare("INSERT INTO accounts (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(await storageKey(account.id), await encryptRecord(account, env))
    .run();
}

export async function deleteAccount(env, accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return false;
  const result = await store(env)
    .prepare("DELETE FROM accounts WHERE key = ?")
    .bind(await storageKey(accountId))
    .run();
  return Number(result.meta?.changes || 0) > 0;
}
