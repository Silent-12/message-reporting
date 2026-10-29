# message-reporting

浏览器错误监控 SDK。提供 CID 签发、持久化、初始化时的上报策略查询，以及允许上报后的浏览器错误自动捕获、环境信息与自定义上下文附加和加密发送。

## 初始化

在 AppPulse 后端创建监控项目并获取 `appId`。新建项目默认使用白名单上报策略，管理员需通过后台接口将签发的 CID 加入白名单；也可切换为全部允许（黑名单除外）或黑名单拒绝。

```ts
import { init, stop } from 'message-reporting'

const result = await init({
  serverUrl: 'https://collector.example/api-prefix',
  appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
})

if (result.status === 'allowed') {
  // CID 已就绪且上报策略允许上报，SDK 已开始自动捕获浏览器错误。
}

stop()
```

`serverUrl` 保留服务端实际 API 路径前缀；生产使用 HTTPS，仅 loopback 开发允许 HTTP。可选 `getContext` 在每个待处理事件发送前调用一次，返回普通 JSON 对象或其 Promise，结果作为独立 `context` 字段加密上报，不会覆盖事件或协议字段。回调最多等待 1 秒，计时从调用回调前开始（回调同步执行的部分无法中断）；同一初始化代次最多同时保留 5 个未结束回调，停止或重新初始化后重新计数；回调抛错、拒绝、超时、循环结构、非 JSON 安全值或超出限制时丢弃整段上下文，基础错误照常发送。上下文整体不超过 4096 字节，容器嵌套最多 3 层，单个对象或数组最多 20 个键或项，键和字符串值分别不超过 64 和 512 个 UTF-8 字节，字符串不做截断。重复初始化（含初始化进行中的同目标重复调用）以最新传入的回调为准。

`init` 返回 `allowed`、`denied`、`invalid_config`、`unavailable`、`failed`、`conflict` 或 `stopped` 状态；部分失败包含 `errorCode`。同一 `serverUrl` 与 `appId` 视为同一监控目标：并发调用共用一次初始化，已允许后重复调用复用允许状态并更新 `getContext`；不同监控目标并发调用返回冲突，停止后可再次初始化。CID 按服务地址和应用隔离存储，不在初始化结果中返回。

## 自动捕获

`init` 返回 `allowed` 后，SDK 在当前窗口安装监听器并自动上报三类浏览器级错误，经同一加密事件通道发送：

- 同步 JavaScript 运行错误：`kind` 为 `javascript`；
- 未处理的 Promise 拒绝：`kind` 为 `unhandledrejection`；
- 图片、脚本及其他资源元素加载失败：`kind` 分别为 `img`、`script`、`resource`。

事件只包含实际可获得的字段：消息、错误名称、堆栈、来源 URL 与行列号，以及去除查询和片段的页面路径。SDK 还会自动附加有限的 `environment`（`userAgent`、`online`、`effectiveType`，仅取浏览器实际提供且读取成功的字段）和 `getContext` 返回的 `context`；明文超限时依次移除上下文、环境信息，仍超限再缩短堆栈。资源元素错误通过捕获阶段监听取得，地址取元素实际加载位置；`data:` 与 `blob:` 地址不进入事件内容。跨域脚本可能只提供受限信息或没有堆栈。初始化之前、等待上报策略结果期间以及 `stop` 之后的错误不缓存、不上报；重复初始化不重复注册。`stop` 只移除 SDK 自己安装的监听器，不覆盖 `window.onerror`，不调用 `preventDefault` 或阻止事件传播。事件风暴受加密准备与上报请求各 5 个并发上限约束，超出的事件在组装前丢弃；没有离线队列，页面关闭或断网时允许丢失。宿主无法移除 SDK 监听器时不会再次注册，避免同一错误被重复上报。

以下范围不在首版承诺内：已被应用或框架吞掉的错误、Shadow DOM 内部元素的资源加载错误、其他 iframe 与 Worker、`console.error` 调用、SDK 安装前的错误、同一页面加载多份 SDK 副本、Source Map 还原。运行环境缺少 `window`、无法注册监听器或不支持 `unhandledrejection` 时，`init` 返回 `unavailable`，不会宣称已开始监控；该能力判定在签发 CID 与查询上报策略之前完成。

请求单次超时 5 秒，网络故障、超时及 5xx 最多按 1、2、4 秒间隔重试三次。签发与上报策略请求体只包含协议字段（`appId`、`cid`），事件请求体为加密信封；内容类型均为 `application/json`，服务端拒绝多余字段与非 JSON 内容类型。签发响应丢失后服务端可能存在未使用的签发记录。CID 不代表可信用户身份。

## 开发和验证

```bash
npm ci
npm run check
```

构建提供 ESM、CJS、IIFE 和类型声明。旧的 `report`、`reportImmediate` 及 GIF/Beacon 接口已移除；错误事件由 SDK 自动采集并经加密通道发送。真实浏览器、接收服务和生产部署的验证状态见 `document/前端错误监控目标总览.md`。
