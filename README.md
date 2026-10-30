# 🛡️ message-reporting

> 面向浏览器 HTML / Vue / React 应用的错误监控 SDK：自动捕获全局错误，附加环境信息与自定义上下文，经加密通道上报到 AppPulse 后端。

![version](https://img.shields.io/badge/version-0.2.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![formats](https://img.shields.io/badge/formats-ESM%20%7C%20CJS%20%7C%20IIFE-orange)

## 📖 项目简介

`message-reporting` 是 AppPulse 错误监控体系的浏览器端 SDK。业务代码只需初始化一次，SDK 会在确认允许上报后自动完成错误采集与上报：

1. 🪪 初始化时签发或复用 **CID**，按服务地址与应用隔离持久化到 `localStorage`；
2. ✅ 向服务端查询**上报策略**，只有明确允许后才开始监控；
3. 🚨 自动捕获 JavaScript 运行错误、未处理的 Promise 拒绝和资源加载失败；
4. 🌐 附加浏览器环境信息，并按需调用 `getContext` 补充业务上下文；
5. 🔒 校验、裁剪并加密事件，通过 `POST /v1/events` 上报。

SDK 以不干扰宿主为目标：不覆盖 `window.onerror`，不阻止事件默认行为或传播，采集与发送过程中的异常不会抛给业务代码。

## ✨ 核心特性

- 🪪 **CID 自动管理**：首次初始化获取 CID 并持久化，后续复用；同一监控目标并发初始化只执行一次。
- ✅ **上报策略准入**：未取得明确允许时不采集、不缓存、不发送事件。
- 🚨 **全局错误自动捕获**：同步 JS 错误、未处理 Promise 拒绝、图片 / 脚本 / 其他资源加载失败。
- 🌐 **环境信息附加**：自动读取 `userAgent`、在线状态与网络有效类型，仅使用浏览器实际提供的字段。
- 🧩 **自定义上下文**：通过 `getContext` 为每条事件附加业务信息，支持同步或异步回调。
- 🔒 **端侧加密**：每条事件使用独立子密钥加密（HKDF-SHA-256 + AES-256-GCM）。
- 🧯 **宿主无侵入**：只安装和移除自己的监听器，不覆盖宿主处理器，不影响事件传播。
- 🧱 **有界与降级**：上下文、事件字段、明文和信封均有大小上限，超限时按明确顺序降级。
- 📦 **多种产物**：同时提供 ESM、CJS、IIFE 与 TypeScript 类型声明。

## 📦 安装

SDK 只通过 GitHub Release 分发，不发布到 npm。按版本安装 Release 中的 tarball：

```bash
# npm（示例版本 0.2.0）
npm install https://github.com/Silent-12/message-reporting/releases/download/v0.2.0/message-reporting-0.2.0.tgz

# pnpm add / yarn add 同样支持该 URL
```

也可以下载 Release 中的 tarball，解压后把 `dist/index.global.js` 自托管，作为独立脚本引入，全局变量名为 `MessageReportingSDK`：

```html
<script src="/cdn/message-reporting/index.global.js"></script>
```

## 🚀 快速开始

### 1. 获取 appId

在 AppPulse 后端创建监控项目并获取 `appId`。新建项目默认使用白名单上报策略，管理员需通过后台接口将签发的 CID 加入白名单；也可切换为全部允许（黑名单除外）或黑名单拒绝。

### 2. 初始化 SDK

```ts
import { init } from 'message-reporting'

const result = await init({
  serverUrl: 'https://collector.example/api-prefix',
  appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
  getContext: () => ({
    route: location.pathname,
    release: '1.2.3',
  }),
})

if (result.status === 'allowed') {
  // CID 已就绪且上报策略允许，SDK 已开始自动捕获浏览器错误。
} else {
  // denied / invalid_config / unavailable / failed / conflict / stopped
  console.warn('错误监控未启动', result)
}
```

`serverUrl` 保留服务端实际 API 路径前缀，支持 HTTP 与 HTTPS 地址；生产环境建议使用 HTTPS。`appId` 为 2 至 64 位小写字母与数字且两者混合的字符串。

### 3. 停止监控

在页面卸载、微前端卸载或需要关闭监控时调用 `stop()`：

```ts
import { stop } from 'message-reporting'

// 只移除 SDK 自己安装的监听器，不会删除已持久化的 CID。
stop()
```

### 4. 通过独立脚本初始化

```html
<script src="/cdn/message-reporting/index.global.js"></script>
<script>
  MessageReportingSDK.init({
    serverUrl: 'https://collector.example/api-prefix',
    appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
  }).then(function (result) {
    if (result.status !== 'allowed') {
      console.warn('错误监控未启动', result)
    }
  })
</script>
```

### 5. Vue / React 接入

在应用入口调用一次 `init` 即可，监听器安装在 `window` 上：

```ts
// Vue: main.ts
import { createApp } from 'vue'
import { init } from 'message-reporting'
import App from './App.vue'

init({ serverUrl: 'https://collector.example/api-prefix', appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' })
createApp(App).mount('#app')
```

```tsx
// React: main.tsx
import { createRoot } from 'react-dom/client'
import { init } from 'message-reporting'
import App from './App'

init({ serverUrl: 'https://collector.example/api-prefix', appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' })
createRoot(document.getElementById('root')!).render(<App />)
```

> 首版捕获的是浏览器级错误。已被应用或框架自行捕获并吞掉的错误、`console.error` 调用不在自动捕获范围内。

> 若页面配置了 CSP，需在 `connect-src` 中放行 `serverUrl`；自托管脚本时还需在 `script-src` 中放行脚本来源。

## ⚙️ API

### `init(options)`

初始化 SDK，返回 `Promise<InitResult>`。

| 选项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `serverUrl` | `string` | ✅ | 服务根地址，保留 API 路径前缀；支持 HTTP 与 HTTPS，须为不含凭据、查询与片段的绝对地址。 |
| `appId` | `string` | ✅ | 服务端分配的应用标识，2 至 64 位小写字母与数字，且两者混合。 |
| `getContext` | `() => Record<string, unknown> \| Promise<Record<string, unknown>>` | ❌ | 事件上下文回调，每个待处理事件发送前调用一次；重复初始化时以最新传入的回调为准。 |

返回值 `status`：

| 状态 | 含义 |
| --- | --- |
| `allowed` | CID 已就绪且上报策略允许，SDK 已安装监听器并开始捕获。 |
| `denied` | 上报策略拒绝当前应用 / CID。 |
| `invalid_config` | 初始化参数不合法，未发起请求。 |
| `unavailable` | 运行环境缺少必要能力（如 Fetch、Web Crypto、可读写存储、监听器支持等）。 |
| `failed` | 请求失败或服务端返回失败，部分情况包含 `errorCode`。 |
| `conflict` | 已存在其他监控目标的初始化，需先 `stop()`。 |
| `stopped` | 初始化过程被 `stop()` 中止。 |

行为说明：

- 同一 `serverUrl` 与 `appId` 视为同一监控目标。并发调用共用一次初始化；已允许后重复调用复用允许状态并更新 `getContext`；不同监控目标并发调用返回 `conflict`。
- 停止后可再次初始化；已持久化的 CID 会按服务地址与应用隔离复用，且**不会通过初始化结果返回**。
- 初始化会先确认运行环境能力，再签发 CID 与查询上报策略；无法监控时返回 `unavailable`，不会宣称已开始监控。

### `stop()`

停止当前监控并清理 SDK 状态：

- 中止进行中的初始化请求与事件发送；
- 移除 SDK 自己安装的浏览器监听器；
- 清除上报允许状态；
- **不删除** `localStorage` 中已持久化的 CID；
- 不覆盖 `window.onerror`，不调用 `preventDefault` 或阻止事件传播。

## 🚨 自动捕获

`init` 返回 `allowed` 后，SDK 自动上报以下浏览器级错误，均经同一加密事件通道发送：

| `kind` | 触发场景 | 说明 |
| --- | --- | --- |
| `javascript` | 未捕获的同步 JavaScript 运行错误 | 来自窗口 `error` 事件。 |
| `unhandledrejection` | 未处理的 Promise 拒绝 | 拒绝值会归一化为消息。 |
| `img` | 图片元素加载失败 | 包含 HTML `<img>` 与 SVG `<image>`。 |
| `script` | 脚本元素加载失败 | 通过捕获阶段监听取得。 |
| `resource` | 其他资源元素加载失败 | 通过捕获阶段监听取得。 |

事件只包含实际可获得的字段：消息、错误名称、堆栈、来源 URL 与行列号、去除查询和片段的页面路径，以及自动采集的 `environment` 和 `getContext` 返回的 `context`。资源元素地址取元素实际加载位置，`data:` 与 `blob:` 地址不进入事件内容。

不在首版承诺内的范围：

- 已被应用或框架吞掉的错误；
- Shadow DOM 内部元素的资源加载错误；
- 其他 iframe 与 Worker 中的错误；
- `console.error` 调用；
- SDK 安装之前发生的错误；
- 同一页面加载多份 SDK 副本；
- Source Map 还原。

其他边界：

- 初始化之前、等待上报策略结果期间以及 `stop` 之后的错误不缓存、不上报；重复初始化不会重复注册监听器。
- 资源元素错误通过捕获阶段取得；跨域脚本可能只提供受限信息或没有堆栈。
- 事件风暴受加密准备与上报请求各 5 个并发上限约束，超出的事件在组装前丢弃。
- 没有离线队列；页面关闭或断网时允许丢失事件。

## 🧵 事件上下文

### 🌐 环境信息

SDK 自动读取以下字段，任一字段缺失、为空或读取失败时直接省略，不推断设备身份或精确网络类型：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `userAgent` | `navigator.userAgent` | 浏览器 User-Agent。 |
| `online` | `navigator.onLine` | 浏览器报告的在线状态。 |
| `effectiveType` | `navigator.connection.effectiveType` | 网络有效类型，例如 `4g`。 |

### 🧩 自定义上下文

```ts
await init({
  serverUrl: 'https://collector.example/api-prefix',
  appId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
  getContext: async () => ({
    route: location.pathname,
    release: '1.2.3',
    featureFlags: ['checkout-v2'],
  }),
})
```

`getContext` 的结果作为独立的 `context` 字段加密上报，不会覆盖事件或协议字段。回调抛错、拒绝、超时或结果不合法时丢弃整段上下文，基础错误照常发送。

| 限制项 | 值 |
| --- | --- |
| 上下文整体 | ≤ 4096 UTF-8 字节 |
| 容器嵌套深度 | ≤ 3 层（根对象算第 1 层） |
| 单个对象键数 | ≤ 20 |
| 单个数组项数 | ≤ 20 |
| 单个键 | ≤ 64 UTF-8 字节 |
| 单个字符串值 | ≤ 512 UTF-8 字节，不做截断 |
| 回调等待时间 | ≤ 1 秒，从调用回调前开始计时 |
| 同时未结束的回调 | ≤ 5 个（每个初始化代次独立计数） |

回调同步执行的部分无法被中断；超时后应用任务不会被取消，但实际未结束的回调会继续占用当前代次的名额。停止或重新初始化后重新计数。

> ⚠️ `context` 会随事件离开浏览器。请勿放入密码、令牌、身份证号、完整 URL 查询参数等敏感信息。

## 🔒 协议与安全

### 请求接口

所有请求都基于 `serverUrl`，并保留其路径前缀：

| 接口 | 用途 | 请求体 |
| --- | --- | --- |
| `POST {serverUrl}/v1/cids` | 签发 CID | `{ "appId": "..." }` |
| `POST {serverUrl}/v1/admission` | 查询上报策略 | `{ "appId": "...", "cid": "..." }` |
| `POST {serverUrl}/v1/events` | 上报加密事件 | 加密信封 |

### 请求行为

- 单次请求超时 5 秒。
- 网络故障、超时及 `5xx` 最多按 1、2、4 秒间隔重试三次；`4xx` 等明确拒绝不重试。
- 内容类型为 `application/json`，请求使用 `credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`cache: 'no-store'`。
- 服务端拒绝多余字段与非 JSON 内容类型；事件重试复用同一加密信封。
- 加密准备与事件请求各有 5 个并发上限。

### 事件加密

每条事件使用随机事件标识与 IV，通过 CID 派生的子密钥加密后发送：

- 密钥派生：HKDF-SHA-256；
- 加密算法：AES-256-GCM（256 位密钥、12 字节 IV、128 位认证标签）；
- 附加认证数据绑定协议版本、`appId`、`cid`、`eventId` 与 `sentAt`；
- 明文上限 32 KiB，完整信封上限 48 KiB；
- 明文超限时依次移除 `context`、`environment`，仍超限再缩短堆栈。

服务端会对每条事件再次校验上报策略，配置变更立即生效。

### 安全提示

- CID 存储在浏览器可读取的 `localStorage` 中，**不代表可信用户身份**；获取 CID 者可构造有效请求。签发记录、上报策略、限流与审计只能降低滥用风险，不能保证阻止刷写。
- SDK 自动去除页面路径与来源 URL 的查询参数和片段，并排除 `data:` / `blob:` 地址；业务上下文中的敏感信息仍需接入方自行控制。
- SDK 允许 HTTP 与 HTTPS 地址；HTTP 不提供传输层保护，生产环境建议使用 HTTPS。
- 不要把 `serverUrl`、CID 或派生密钥当作鉴权凭据；它们不能替代服务端身份认证与授权。

## 🧱 运行要求与兼容性

构建语法目标为 ES2019，但运行时能力会在初始化时逐项检测；缺少以下能力时 `init` 返回 `unavailable`，且不会签发 CID 或查询上报策略：

| 能力 | 用途 |
| --- | --- |
| `fetch`、`AbortController` | 发起与中止请求。 |
| `crypto.subtle`、`crypto.getRandomValues` | 密钥派生、加密与随机标识。 |
| `TextEncoder`、`TextDecoder` | UTF-8 编码与协议处理。 |
| `atob`、`btoa` | base64url 编解码。 |
| 可读写的 `localStorage` | CID 持久化。 |
| `window.addEventListener` / `removeEventListener`、`unhandledrejection` 支持 | 安装浏览器错误监听器。 |

浏览器验收矩阵覆盖 Windows Chrome / Edge / Firefox、macOS Safari、Android Chrome 与 iOS Safari 的验收时当前及上一稳定版；目前源码与自动化测试已覆盖，真实浏览器矩阵与真实接收端联调尚未执行。原生微信小程序、SSR、Worker 与其他页面上下文不在首版承诺内。

## 📁 项目结构

```text
src/
├── index.ts        # init / stop、配置校验与初始化状态机
├── capture.ts      # 浏览器错误监听与事件组装
├── event.ts        # 事件校验、裁剪、加密与发送
├── context.ts      # getContext 调用、超时与上下文归一化
├── environment.ts  # 浏览器环境信息采集
├── request.ts      # 5 秒超时与有限重试的 JSON POST
├── base64url.ts    # base64url 编解码
├── safe-read.ts    # 宿主属性安全读取
└── types/          # 公开类型声明
tests/              # Node.js 内置测试、协议向量与宿主模拟
document/           # 目标、协议与验证记录文档
```

## 🛠️ 开发与验证

要求 Node.js >= 18（仅开发与测试需要；SDK 运行时是浏览器）。

```bash
# 按锁文件安装依赖
npm ci

# 类型检查 + lint + 格式检查 + 构建 + 测试
npm run check
```

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 清理并构建 ESM、CJS、IIFE 与类型声明。 |
| `npm run typecheck` | TypeScript 类型检查。 |
| `npm run lint` | ESLint 检查。 |
| `npm run format` | Prettier 格式检查。 |
| `npm test` | 先构建，再运行 `tests/*.test.mjs`。 |
| `npm pack --dry-run` | 检查发布包内容与入口。 |
| `npm run release:pack` | 执行完整检查并生成 GitHub Release 用的 tarball。 |

构建产物位于 `dist/`：

| 文件 | 格式 | 说明 |
| --- | --- | --- |
| `dist/index.js` | ESM | `import { init, stop } from 'message-reporting'` |
| `dist/index.cjs` | CJS | `require('message-reporting')` |
| `dist/index.global.js` | IIFE | 全局变量 `MessageReportingSDK` |
| `dist/index.d.ts` / `index.d.cts` | 类型声明 | ESM / CJS 类型入口。 |

## 🚢 发布（GitHub Release）

SDK 不发布到 npm，发布流程由 GitHub Actions 完成：

1. 更新 `package.json` 的 `version` 并提交。
2. 打 tag 并推送，tag 必须与版本号一致：

```bash
git tag v0.2.0
git push origin v0.2.0
```

3. [`.github/workflows/release.yml`](.github/workflows/release.yml) 会执行 `npm ci --ignore-scripts`、`npm run release:pack`（内部包含 `npm run check`）并创建 Release，附件为 `message-reporting-0.2.0.tgz`。
4. 消费端按上文安装 URL 使用；IIFE 用户可从附件中取 `dist/index.global.js` 自托管。

本地手动打包（不上传）：

```bash
npm run release:pack
```

## 📚 文档

- [前端错误监控目标总览](document/前端错误监控目标总览.md)
- [前端错误监控分阶段调整方案](document/前端错误监控分阶段调整方案.md)
- [目标 01：协议与安全边界](document/目标01-协议与安全边界.md)
- [目标 02：CID 与上报策略](document/目标02-CID与上报策略.md)
- [目标 03：事件与加密发送](document/目标03-事件与加密发送.md)
- [目标 04：浏览器自动捕获](document/目标04-浏览器自动捕获.md)
- [目标 05：环境与自定义上下文](document/目标05-环境与自定义上下文.md)
- [目标 06：接入验证与框架扩展](document/目标06-接入验证与框架扩展.md)

## ⚠️ 当前状态

- 当前版本 **0.2.0**。初始化、CID、上报策略、自动捕获、环境信息、自定义上下文、加密发送与多格式产物均已实现并有自动化测试覆盖。
- 真实浏览器矩阵、真实接收端联调、Vue / React 实际接入和生产部署验收尚未执行；首次接入建议先在测试环境完成「初始化 → 触发错误 → 接收端落库」的完整联调。
- 首版没有离线队列、旧通道兼容层和 Source Map 还原能力；页面关闭或断网时允许丢失事件。
- 分发方式为 GitHub Release tarball，不发布到 npm；Release 由 tag 触发的 GitHub Actions 生成。

## 📄 License

MIT
