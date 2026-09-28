function store(env) {
  if (!env.WEIXIN_ACCOUNTS || typeof env.WEIXIN_ACCOUNTS.prepare !== "function") {
    throw new Error("account_store_unavailable");
  }
  return env.WEIXIN_ACCOUNTS;
}

export async function getAdminCredential(env) {
  return store(env)
    .prepare("SELECT salt, password_hash FROM admin_credentials WHERE id = 1")
    .first();
}

export async function createAdminCredential(env, { salt, passwordHash, createdAt }) {
  const result = await store(env)
    .prepare("INSERT OR IGNORE INTO admin_credentials (id, salt, password_hash, created_at) VALUES (1, ?, ?, ?)")
    .bind(salt, passwordHash, createdAt)
    .run();
  return Number(result.meta?.changes || 0) === 1;
}
