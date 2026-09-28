# weixin-webhook-worker · 设计文档

把 HTTP Webhook 通知**实时转发到微信**的 Cloudflare Worker。

- **单微信账号**：只连一个微信号，去掉多账号与管理后台。
- **只用 KV**：不需要 D1、不需要 R2，账号凭证明文存 KV。
- **不用 Cron**：收到 `/notify` 请求时同步补上下文并发送，全程无定时任务。
- **一键部署**：点一下按钮即可部署到你自己的 Cloudflare 账号。

依赖极少、结构极简：`common.js` 放纯逻辑，`index.js` 只是 HTTP 适配层，
`store.js` 是唯一直接碰运行时的模块。

---

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/weixin-webhook-worker-minimal)

点击按钮后，Cloudflare 会读取 `wrangler.toml`，自动为你创建 KV 命名空间并绑定。

> `wrangler.toml` 里的 `[[kv_namespaces]]` **刻意没有写 `id`** —— 这是触发自动预配的正确写法。
> 写上占位 id 会被当成「已存在的命名空间」去解析，反而报配置错误。

**不需要填写任何密钥。** 部署完直接访问 `/init` 即可开始扫码——
签名密钥会在首次使用时自动生成并存进 KV。详细原理见下方「关于密钥」一节。

> 前提：本仓库需为 **公开仓库**，且位于 GitHub 根目录（不支持 GitLab / monorepo 子目录）。

### 手动部署（可选）

```bash
npm install
npx wrangler login

# 创建 KV。命令会输出 namespace id，按需填回 wrangler.toml 的 [[kv_namespaces]]；
# 不填也行：wrangler deploy 会自动预配并把 id 写回。
npx wrangler kv namespace create WEIXIN_KV

npm run deploy
```

---

## 关于密钥

整个服务只涉及两种令牌，且**都不需要你手动配置**：

| 名称 | 存储位置 | 生成时机 | 作用 |
| --- | --- | --- | --- |
| `signing-secret` | KV，自动生成 | 首次访问 `/init` 时 | 给扫码票据做 HMAC 签名，让服务端无需保存会话 |
| 通知令牌 | KV，自动生成 | 扫码成功时 | 调用 `/notify` 时的 `Bearer` 凭据 |

**它们都不用手填。** 你唯一要做的是在扫码成功页把「通知令牌」复制走，接到自己的系统里。

### 可选：固定签名密钥

如果你想固定票据签名密钥（例如有多实例部署，或想自己掌控），
可以设置环境变量 `NOTIFY_TOKEN`，它会被优先用作签名密钥：

```bash
# 本地开发
echo "NOTIFY_TOKEN=$(openssl rand -hex 32)" > .dev.vars

# 线上（已部署后追加）
npx wrangler secret put NOTIFY_TOKEN
```

不设置时走自动生成，功能完全一样。

---

## 初始化：让机器人连上你的微信

部署完成后访问 `https://<你的域名>/init`，页面会：

1. 申请二维码并展示。
2. 你用手机微信扫码、在手机上确认。
3. 依次返回**调用地址**、**通知令牌**和一段可直接复制的 `curl` 示例。

初始化成功后 `/init` 会返回 **404**，避免重复暴露。

> ⚠️ **重要前提**：微信机器人只能给「**先主动给它发过消息**」的用户发通知。
> 扫码完成后，请先在微信里给这个机器人发一句话，上下文才会建立；
> 之后 `/notify` 才能把消息推给你。

---

## 重新绑定 / 解除绑定

绑定不是永久的：**想换一个微信号、或者令牌丢了，去 Cloudflare 控制台删掉 KV 里的一条记录即可。**

1. 打开 Cloudflare 控制台 → **Workers & Pages** → 选中你的 Worker
2. 进入 **Storage & Databases** → **KV** → 选中本项目的命名空间
3. 在 **KV Pairs** 里删除 `account` 这个键
4. 重新访问 `https://<你的域名>/init`，扫码页就回来了

命令行等价操作：

```bash
# 查看有哪些键
npx wrangler kv key list --binding WEIXIN_KV --remote

# 删除账号记录，即可重新扫码
npx wrangler kv key delete account --binding WEIXIN_KV --remote
```

> 注意：**只删 `account`，不要删 `signing-secret`。**
> `signing-secret` 是自动生成的票据签名密钥，删掉只会让正在进行的二维码失效，没有其他影响；
> 但既然没必要，就别动它。

重新扫码成功后会**下发一把新的通知令牌**，旧的立即失效——记得更新调用方。

### 本地测试环境

本地凭证就是一个文件，直接删掉即可：

```bash
node cli.mjs logout          # 删除 .local-session.json，之后可重新 login
```

---

## 发送通知

```bash
curl -X POST https://<你的域名>/notify \
  -H "Authorization: Bearer <你的通知令牌>" \
  -H "Content-Type: application/json" \
  -d '{"text": "构建完成 ✅"}'
```

成功后返回 `{"ok":true}`。常见错误：

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| 401 | 令牌错误 | 检查 `Authorization` 头 |
| 400 | `text` 为空或超长（上限 4000 字） | 检查请求体 |
| 409 | `weixin_context_missing` | 先在微信里给机器人发一条消息 |
| 502 | 微信上游不可达 | 稍后重试 |

Worker 内部对「上下文失效」做了自愈：发送失败且上游返回 `-2` 时，
会重置游标并在同一请求内重试一次，无需人工干预。

另外，微信上游的 `getupdates` / `get_qrcode_status` 都是**长轮询**（实测会挂起约 18 秒才返回空结果），
因此客户端超时设为 40 秒，并对超时/网络抖动按预算自动重试——「暂无新消息」不会被误判成故障。

---

## 本地开发（不依赖 Cloudflare）

`cli.mjs` 是一个**纯 Node 入口**，复用 `src/common.js` 的同一份逻辑，
把凭证保存在本地 `.local-session.json`，用于在没有 Cloudflare 的情况下走通整条链路。

```bash
node cli.mjs login           # 终端里渲染二维码，手机扫码，凭证存到本地
node cli.mjs status          # 查看当前连接状态
node cli.mjs send "测试消息"  # 发送一条通知
node cli.mjs logout          # 删除本地凭证
```

终端二维码用半块字符绘制（`█ ▀ ▄`），可直接被手机相机扫描。

`.local-session.json` 已在 `.gitignore` 中，不会提交。

---

## 测试

```bash
npm test        # 纯逻辑单测 + HTTP 层验收测试
```

- `test/common.test.mjs`：`common.js` 的纯函数单测，注入假 `fetch`，**52 项**。
- `test/acceptance.mjs`：用假 KV + 假上游跑通全部路由，**28 项**。

另有一个可选的交叉校验脚本（改动二维码代码时手动运行）：

```bash
npm install --no-save qrcode jsqr
node test/manual/qr-cross-check.mjs
```

它用第三方 `jsQR` 解码还原矩阵，并与 `qrcode` 库比对固定图形，
证明 CLI 打印出来的终端二维码真实可扫。

---

## 环境变量

全部可选——不配置任何变量也能正常使用。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `NOTIFY_TOKEN` | 否 | 固定票据签名密钥。不设置时自动生成并存进 KV。 |
| `WEIXIN_CHANNEL_VERSION` | 否 | 微信通道版本，默认 `2.4.9`，见 `wrangler.toml`。 |
| `WEIXIN_APP_ID` | 否 | 应用标识，默认 `bot`。 |

---

## 目录结构

```
src/
  common.js      运行时可移植的纯逻辑（iLink 调用、票据签名、状态推进）
  index.js       HTTP 适配层：路由、鉴权、错误映射
  store.js       KV 存储（account 账号记录、signing-secret 签名密钥）
  init-page.js   初始化页面（单文件 HTML，内联 CSS/JS）
cli.mjs          不依赖 Cloudflare 的本地测试入口
```

KV 里只有两个键：

| 键 | 内容 | 何时删除 |
| --- | --- | --- |
| `account` | 账号凭证、上下文、通知令牌 | 想重新绑定时删它 |
| `signing-secret` | 票据签名密钥 | 一般不用动 |
