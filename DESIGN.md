# weixin-webhook-worker · 设计文档

**用 HTTP 请求给你的微信发消息**的 Cloudflare Worker：你发一个 POST，微信就收到一条通知。

- **单微信账号**：只连一个微信号，去掉多账号与管理后台。
- **只用 KV**：不需要 D1、不需要 R2，账号凭证明文存 KV。
- **不用 Cron**：收到 `/notify` 请求时当次同步发送，全程无定时任务。
- **不带会话上下文**：发送时省略可选的 `context_token`，省掉每轮 `getupdates` 长轮询。
- **失败不掩盖**：上游拒绝时把它的 `ret` / `errcode` / `errmsg` 原样返回。
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

> ⚠️ **重要前提**：微信机器人只能给「**在 24 小时内主动给它发过消息**」的用户发通知。
> 扫码完成后，请先让收件人在微信里给这个机器人发一条消息，之后 `/notify` 才能送达。
> 原因见下一节。

---

## ⚠️ 微信侧的硬约束：24 小时窗口与 10 条配额

这是**服务端策略**，任何实现都绕不过去，也是「消息发不出去」最常见的原因：

```
收件人给机器人发一条消息  →  开启 24 小时窗口，配额重置为 10 条
                        →  窗口内最多下发 10 条
                        →  超出窗口 / 配额用尽  →  消息被丢弃
```

两个容易误判的点：

- **只由「收件人发消息」重置。** 机器人自己发出的通知不会重置窗口，反而消耗 1 条配额。
- **与是否携带 `context_token` 无关。** 换成带上下文的发送方式，一样会被丢弃。

所以长期无人值守的推送，**每 24 小时需要收件人主动发一次消息**才能续上。
窗口关闭时上游会拒绝发送，本服务把它的原始错误一并返回（通常是 `ret = -2`）；
看到它，就说明该让对方在微信里给机器人发条消息了。

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

成功后返回 `{"ok":true,"messageId":"..."}`。常见错误：

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| 401 | 令牌错误 | 检查 `Authorization` 头 |
| 400 | `text` 为空或超长（上限 4000 字） | 检查请求体 |
| 502 | 上游拒绝或不可达 | 看响应里的 `upstreamRet` / `upstreamErrmsg` |
| 503 | `weixin_bot_token_stale` | 绑定已失活，删掉 KV 里的 `account` 重新扫码 |

### 发送策略：不带上下文，失败不掩盖

**发送时不带 `context_token`。** 它在官方实现里是可选的会话标识，缺失时只记一条告警、
照常发送；带上它却要先跑一轮 `getupdates` 长轮询（实测挂起约 18 秒），
等于把延迟灌进通知链路。省掉它之后，一次 `/notify` 只有两次子请求：读 KV、发消息。

**失败时不补救。** 上游的原始错误会原样出现在响应体里：

```json
{
  "ok": false,
  "error": "weixin_send_failed",
  "upstreamStatus": 200,
  "upstreamRet": -2,
  "upstreamErrmsg": "..."
}
```

唯一做的一层归一化：把 `errcode = -14`（bot 令牌失活）单独识别为
`weixin_bot_token_stale` 并返回 503——这一种重试没有意义，只能重新扫码。

> 调用方要注意：`ret = -2` 绝大多数情况下意味着**收件人的 24 小时窗口已关闭**，
> 而不是程序有 bug。见上文「微信侧的硬约束」。

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

- `test/common.test.mjs`：`common.js` 的纯函数单测，注入假 `fetch`，**57 项**。
- `test/acceptance.mjs`：用假 KV + 假上游跑通全部路由，**29 项**。

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
  common.js      运行时可移植的纯逻辑（iLink 协议调用、票据签名、状态工具）
  index.js       HTTP 适配层：路由、鉴权、错误映射
  store.js       KV 存储（account 账号记录、signing-secret 签名密钥）
  init-page.js   初始化页面（单文件 HTML，内联 CSS/JS）
cli.mjs          不依赖 Cloudflare 的本地测试入口
```

KV 里只有两个键：

| 键 | 内容 | 何时删除 |
| --- | --- | --- |
| `account` | 账号凭证与通知令牌 | 想重新绑定时删它 |
| `signing-secret` | 票据签名密钥 | 一般不用动 |

> `common.js` 里仍保留 `pullUpdates` / `applyUpdates` / `invalidateContext` 这几个
> 上下文相关的接口（均有单测覆盖），但**发送链路已不再调用它们**。保留是为了让这一层
> 仍是完整的 iLink 协议映射，需要时能一行接回。
