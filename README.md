# message-reporting

浏览器错误监控 SDK。目前已提供 CID 签发、持久化与准入初始化；错误采集和加密事件发送仍在后续目标中实现。

## 初始化

在 AppPulse 后端创建监控项目并获取 `appId`。新建项目默认使用白名单准入，管理员需通过后台接口将签发的 CID 加入白名单；也可切换为全部允许（黑名单除外）或黑名单拒绝。

```ts
import { init, stop } from 'message-reporting'

const result = await init({
  serverUrl: 'https://collector.example/api-prefix',
  appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
})

if (result.status === 'allowed') {
  // CID 和准入已就绪；错误捕获与发送尚未实现。
}

stop()
```

`serverUrl` 保留服务端实际 API 路径前缀；生产使用 HTTPS，仅 loopback 开发允许 HTTP。可选 `getContext` 回调留待后续事件上下文功能使用，目前不会调用；重复初始化（含初始化进行中的同目标重复调用）以最新传入的回调为准。

`init` 返回 `allowed`、`denied`、`invalid_config`、`unavailable`、`failed`、`conflict` 或 `stopped` 状态；部分失败包含 `errorCode`。同一 `serverUrl` 与 `appId` 视为同一监控目标：并发调用共用一次初始化，已允许后重复调用复用允许状态并更新 `getContext`；不同监控目标并发调用返回冲突，停止后可再次初始化。CID 按服务地址和应用隔离存储，不在初始化结果中返回。

请求单次超时 5 秒，网络故障、超时及 5xx 最多按 1、2、4 秒间隔重试三次。请求体只包含协议字段（`appId`、`cid`），内容类型为 `application/json`；服务端拒绝多余字段与非 JSON 内容类型。签发响应丢失后服务端可能存在未使用的签发记录。CID 不代表可信用户身份。

## 开发和验证

```bash
npm ci
npm run check
```

构建提供 ESM、CJS、IIFE 和类型声明。旧的 `report`、`reportImmediate` 及 GIF/Beacon 接口已移除；本阶段不发送业务事件。真实浏览器、接收服务和生产部署的验证状态见 `document/前端错误监控目标总览.md`。
