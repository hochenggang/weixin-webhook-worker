# weixin-webhook-worker

**用 HTTP 请求给你的微信发消息。** 你发一个 POST 请求，微信就收到一条通知——单账号、只用 KV、无常驻进程。

## 三步用起来

1. **点按钮部署**  

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/weixin-webhook-worker)

2. **访问 `/init` 扫码** → 手机上确认后，页面给出**调用地址**与**通知令牌**。
3. **发一条 HTTP 请求**：

   ```bash
   curl -X POST https://<你的域名>/notify \
     -H "Authorization: Bearer <你的通知令牌>" \
     -H "Content-Type: application/json" \
     -d '{"text": "构建完成"}'
   ```

   发出后，你的微信就会收到一条「构建完成」。

> 部署无需填任何密钥。扫码后**请先在微信里给这个机器人发一句话**，上下文才会建立，之后的通知才能送达。

## 本地跑通（不装 Cloudflare）

```bash
npm install
node cli.mjs login      # 终端里扫码，凭证存到本地
node cli.mjs send "测试消息"
```

## 更多

部署方式、密钥原理、重新绑定、错误码、测试与目录结构，见 **[DESIGN.md](./DESIGN.md)**。
