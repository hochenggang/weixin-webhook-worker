# weixin-webhook-worker · 设计文档

**用 HTTP 请求给你的微信发消息**的 Cloudflare Worker：你发一个 POST，微信就收到一条通知。

- **单微信账号**：只连一个微信号，去掉多账号与管理后台。
- **只用 KV**：不需要 D1、不需要 R2，账号凭证明文存 KV。
- **不用 Cron**：收到 `/notify` 请求时当次同步发送，全程无定时任务。
- **只实现推送链路**：扫码登录 + 发消息，不做接收侧，因此不碰 `getupdates`。
- **响应按协议透传**：上游的 `ret` / `errcode` / `errmsg` 原样返回，不改名、不补默认值。
- **一键部署**：点一下按钮即可部署到你自己的 Cloudflare 账号。

依赖极少、结构极简：`common.js` 放纯逻辑，`index.js` 只是 HTTP 适配层，
`store.js` 是唯一直接碰运行时的模块。

---

## 资料可信度分级（重要）

本项目只依赖一份权威资料，其余都是参考。判断某个字段能不能用之前，先看它属于哪一级：

| 级别 | 资料 | 用法 |
| --- | --- | --- |
| **权威 · 协议事实** | 微信后端 API 协议文档（`openclaw-weixin` 仓库 `docs/protocol.zh_CN.md`） | 请求/响应字段、状态码、二维码状态机，**唯一判断依据** |
| 参考 · 实现行为 | 同仓库客户端源码（`api.ts` / `types.ts` / `messaging/send.ts` 等） | 只用于理解用法，**不作为契约**；与协议冲突时以协议为准 |
| 参考 · 第三方观察 | 社区逆向分析、第三方实现（Go 版等） | 线索，**未经协议或实测确认不得写进代码逻辑** |
| — | 本项目的实测记录 | 只记录现象；结论必须能追到上面某一级 |

协议文档自己就声明了这条边界（原文）：

> 客户端类型和行为不能代表完整的服务端契约。尤其是，TypeScript 字段标记为可选，
> 不代表服务端一定接受省略该字段的请求；类型中定义了某个字段，也不代表插件已经实现所有相关能力。
>
> JSON 示例用于展示部分字段，不代表经过验证的最小可用请求或完整响应。

**因此本项目的取舍是**：只实现协议写明的部分，不搬运参考实现里的私有做法
（例如为 uint64 字段改写 JSON 的解析器、把客户端自生成的 `client_id` 当作服务端消息 ID 返回、
靠「有没有 `message_id`」这类类型定义里的可选字段来判断业务结果）。

---

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/weixin-webhook-worker)

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

### `/init` 什么时候可用（404 的判定）

| 请求 | KV 里有 `account` | 结果 |
| --- | --- | --- |
| `GET /init` | 没有 | **200** 扫码页 |
| `GET /init` | 有 | **404**（页面不再暴露） |
| `POST /init` | 任意 | 405 |
| 其他未知路径 | 任意 | 404 |

也就是说：**唯一会 404 的原因是「已经绑定过」**。

> 重新绑定**不提供接口**，只能到 Cloudflare 控制台删掉 KV 里的 `account` 键（见「重新绑定」）。
> 这是刻意的取舍：能删数据的入口越少越好，而换号本来就不常做。

> ⚠️ **重要前提**：微信机器人只能给「**在 24 小时内主动给它发过消息**」的用户发通知。
> 扫码完成后，请先让收件人在微信里给这个机器人发一条消息，之后 `/notify` 才能送达。
> 原因见下一节。

---

## ⚠️ 微信侧的硬约束：24 小时窗口与 10 条配额

这是**服务端策略**，任何实现都绕不过去，也是「消息发不出去」最常见的原因：

```
收件人给机器人发一条消息  →  开启 24 小时窗口，配额重置为 10 条
                        →  窗口内最多下发 10 条
                        →  超出窗口 / 配额用尽  →  消息不再送达
```

两个容易误判的点：

- **只由「收件人发消息」重置。** 机器人自己发出的通知不会重置窗口，反而消耗 1 条配额。
- **与请求体里的字段无关。** 协议里可选的 `context_token` 是「回复某条会话」的关联字段，
  换不换它都改变不了窗口状态。

所以长期无人值守的推送，**每 24 小时需要收件人主动发一次消息**才能续上。

> **可信度提醒**：「24 小时 + 10 条」来自第三方实测与社区观察（上述分级里的「参考」级），
> 协议文档并未记载这条策略，服务端也可能随时调整。因此代码里**不做任何基于窗口的推断**
> （不猜测窗口是否关闭、不预判配额是否用尽）——只如实转述上游对每次发送的回答。

---

## 重新绑定（换微信号 / 重新扫码）

绑定不是永久的，但**唯一的解绑方式是删掉 KV 里的账号记录**——服务端不提供解绑接口。

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

> 为什么不做成接口：删数据的能力多一个入口就多一份风险，
> 而换号是低频操作——去控制台点两下完全够用，不值得为它开一个能删记录的 HTTP 面。
>
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

成功后返回 **`ok` 加上上游的协议字段**，字段名与协议一致，不做任何重命名：

```json
{ "ok": true, "ret": 0, "errmsg": "" }
```

常见错误：

| 状态码 | 响应 | 含义 | 处理 |
| --- | --- | --- | --- |
| 401 | `unauthorized` | 令牌错误 | 检查 `Authorization` 头 |
| 400 / 413 | `text_required` / `text_too_long` | `text` 为空或超长（上限 4000 字） | 检查请求体 |
| 502 | `weixin_send_failed` + `ret` / `errmsg` | 上游没有接受这次发送 | 看 `ret` / `errmsg` 原文 |
| 503 | `weixin_bot_token_stale` | 绑定已失活（上游报 `-14`） | 删掉 KV 里的 `account` 重新扫码，见「重新绑定」 |

### 发送策略：请求只带协议要求的最小集合

请求体按协议构造：`to_user_id`（扫码时拿到的用户 ID，永久有效）、`client_id`、
`message_type` / `message_state`、`item_list`，加上 `base_info`。

协议里可选的 `context_token` **不发**：它的用途是「回复对应的会话」，
而本服务是单向推送、不接收任何消息，因此没有会话可回复。协议不要求它，
省掉它就不必为了拿到它去跑 `getupdates` 长轮询（实测挂起约 18 秒）。
一次 `/notify` 只有两次子请求：读 KV、发消息。

### 成功与否的判定：只看协议字段

```json
{
  "ok": false,
  "error": "weixin_send_failed",
  "upstreamStatus": 200,
  "ret": 0,
  "errmsg": "content_miss"
}
```

- `ret` / `errcode` 非 0 → 失败（协议：`ret: 0` 表示成功）。
- `ret` 为 0 但 `errmsg` 非空 → 失败。协议称 `errmsg` 为「可选的错误描述」，
  成功示例里它是空串；上游既然描述了错误，就不报成功。
- 失败时把 HTTP 状态与上游字段一并返回（`upstreamStatus` + 协议原字段），
  **不翻译、不吞、不补默认值**。
- 唯一做的一层归一化：把 `-14`（bot 令牌失活）单独识别为 `weixin_bot_token_stale` 并返回 503——
  这一种重试没有意义，只能重新扫码。

> 调用方要注意：拿不到 `message_id` 之类的「送达回执」是正常的——协议里
> `sendMessage` 的响应只有 `ret` 与 `errmsg`，没有任何投递凭证。
> 若上游对所有请求都回 `ret: 0` + 空 `errmsg`，那么**任何客户端都无法从响应上分辨送达与否**，
> 这时只能靠上面的窗口机制解释。

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

- `test/common.test.mjs`：`common.js` 的纯函数单测，注入假 `fetch`，**43 项**。
- `test/acceptance.mjs`：用假 KV + 假上游跑通全部路由，**33 项**。

`test/html-loader.mjs` 是测试专用的加载钩子：Node 不认识 `.html` 导入，
而 Worker 侧由 wrangler 内置的 Text 规则把 `src/init.html` 内联成字符串，
这个钩子让两端行为一致（见「目录结构」）。

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
  common.js      运行时可移植的纯逻辑（协议调用、票据签名、账号记录）
  index.js       HTTP 适配层：路由、鉴权、错误映射
  store.js       KV 存储（account 账号记录、signing-secret 签名密钥）
  init.html      初始化页面（真正的 HTML 文件，内联 CSS/JS）
cli.mjs          不依赖 Cloudflare 的本地测试入口
test/
  common.test.mjs    纯逻辑单测
  acceptance.mjs     HTTP 层验收
  html-loader.mjs    Node 侧加载 .html 的钩子，与 wrangler 的 Text 规则对齐
```

页面为什么是 `.html` 而不是 JS 字符串：`index.js` 直接 `import INIT_PAGE from "./init.html"`，
**Worker 运行时没有文件系统**，所以「读取 init.html」发生在打包阶段——
wrangler 内置规则默认把 `**/*.html` 当文本模块内联，因此 `wrangler.toml` 里不需要额外 `[[rules]]`。
好处是页面保持为真正的 HTML，不必再塞进 JS 模板字符串里手工转义
（本项目早期两次线上故障都源于此：`\\"` 层级写错导致二维码脚本语法错误）。

KV 里只有两个键：

| 键 | 内容 | 何时删除 |
| --- | --- | --- |
| `account` | 账号凭证与通知令牌 | 想重新绑定时删它 |
| `signing-secret` | 票据签名密钥 | 一般不用动 |

> 只实现推送链路需要的协议部分：扫码登录 + 发消息。
> 没有接收侧，因此不实现 `getupdates` 与上下文游标——**用不到的协议面就不写进代码**。
