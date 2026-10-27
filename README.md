# 📡 message-reporting

一个面向浏览器环境的轻量级手动上报 SDK，支持 HTML 直引和 Vue/TypeScript 模块化接入，并根据页面阶段、能力检测与数据体积在 `sendBeacon`、`fetch`、`gif` 之间自动选择通道。

当前独立仓库版本为 `0.2.0`，最初由原 monorepo 的 SDK 原样迁移，当前仅保留业务上报能力，尚未发布此版本。迁移来源与验证记录见 [MIGRATION.md](./MIGRATION.md)。SDK 不依赖原后端，上报接收地址由接入方配置；本次迁移没有新增自动错误捕获能力。

## 🎯 项目定位

用于在浏览器端手动上报业务数据（如埋点、日志等），支持多种发送方式并自动降级，确保在不同浏览器环境和页面状态下都能可靠地上报数据。

SDK 按 JSON 发送业务载荷，自动补充 `traceId`，并可通过 `includeRuntimeInfo` 携带运行时信息。fetch/beacon 使用 JSON 请求体；GIF 使用 `data` 查询参数承载 JSON，并添加仅用于防缓存的 `_ts`。GIF 地址支持已有查询参数、相对路径和 URL 片段，SDK 会替换重复的 `data`、`_ts` 参数并保留其他参数。

## 🛠️ 技术栈

- **语言**: TypeScript（严格模式）
- **构建工具**: tsup
- **目标环境**: ES2019+ 浏览器
- **产物格式**: ESM、CJS、IIFE（全局变量 `MessageReportingSDK`）

## ✨ 功能说明

- 提供 `init` 初始化方法，统一配置上报地址与发送选项
- 提供 `report` 和 `reportImmediate` 两个手动上报入口
- 支持 `sendBeacon`、`fetch`、`gif` 三种发送方式与可预测降级链路
- 输出 `esm`、`cjs`、`iife` 三种构建格式
- 暴露完整 TypeScript 类型定义
- 自动采集运行时环境信息（浏览器、操作系统、网络状态等）
- 支持跨页面 traceId 追踪，便于后端串联用户会话链路
- 自动识别微信/支付宝 H5 容器

## 📦 安装依赖

克隆本仓库后，使用 Node.js 18+ 和 npm 安装开发依赖；已提供重新生成的独立锁文件：

```bash
npm ci
```

### 开发检查

```bash
npm run check       # 类型检查、lint、格式检查、构建与测试
npm test            # 构建并运行 Node.js 内置测试，无额外测试框架依赖
npm run clean       # 跨平台清理构建目录
npm pack --dry-run  # 检查发布文件，不会发布 npm 包
```

测试覆盖 ESM、CJS、IIFE 的导出和上报行为，使用浏览器能力替身及独立的本地 HTTP 接收器，无需启动原仓库后端。`npm install` / `npm ci` 会通过 `prepare` 安装 Husky；提交前只执行 lint 和格式检查，不自动改写源码或扩大暂存范围，提交信息由 commitlint 校验。需要手动整理格式时可执行 `npm run format:write`。

`npm run release` 会发布公开 npm 包，且会先执行完整检查；发布凭据通过 `npm login` 管理，不在仓库内保存 token。本次迁移只初始化本地 Git，没有创建提交、配置远程或发布包。

## 🔨 构建

```bash
npm run build
```

构建完成后会生成以下产物：

- `dist/index.js` - ESM 格式
- `dist/index.cjs` - CJS 格式
- `dist/index.global.js` - IIFE 格式（全局变量 `MessageReportingSDK`）
- `dist/index.d.ts` - TypeScript 类型定义

## 🚀 模块化接入（Vue/TypeScript）

### 基础用法

```ts
import { init, report, reportImmediate } from '@hulihan97/message-reporting';

// 初始化 SDK
init({
  endpoint: 'https://api.example.com/report',
  gifEndpoint: 'https://api.example.com/report.gif',
});

// 常规事件上报
await report({
  event: 'page_view',
  page: '/home',
});

// 即时上报（适用于页面退出场景）
await reportImmediate({
  event: 'page_exit',
  page: '/home',
});
```

### 页面退出场景

```ts
// 监听页面可见性变化，在页面隐藏时立即上报
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    reportImmediate({
      event: 'page_leave',
      duration: Date.now() - pageEnterTime,
    });
  }
});
```

### 完整配置示例

```ts
init({
  // 主上报地址（必填）
  endpoint: 'https://api.example.com/report',
  // gif 兜底上报地址（可选，默认复用 endpoint）
  gifEndpoint: 'https://api.example.com/report.gif',
  // 自定义请求头（可选）
  headers: {
    'X-Custom-Header': 'value',
  },
  // fetch 请求凭据模式（可选，默认 'same-origin'）
  fetchCredentials: 'include',
  // beacon 最大 payload 体积（可选，默认 60KB）
  beaconMaxPayloadBytes: 60 * 1024,
  // gif 最大 payload 体积（可选，默认 1.5KB）
  gifMaxPayloadBytes: 1500,
  // 小包是否优先使用 gif（可选，默认 true）
  preferGifForSmallPayload: true,
  // 是否携带运行时环境信息（可选，默认 false）
  includeRuntimeInfo: false,
});
```

## 🌐 原生 HTML 使用方式

### 方式一：本地文件引入

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SDK 示例</title>
</head>
<body>
  <button id="btn-report">点击上报</button>

  <!-- 引入 SDK -->
  <script src="./dist/index.global.js"></script>
  <script>
    // 初始化 SDK
    MessageReportingSDK.init({
      endpoint: 'https://api.example.com/report',
      gifEndpoint: 'https://api.example.com/report.gif',
    });

    // 按钮点击上报
    document.getElementById('btn-report').addEventListener('click', function() {
      MessageReportingSDK.report({
        event: 'button_click',
        button: 'submit',
        timestamp: Date.now(),
      }).then(function(result) {
        console.log('上报结果:', result);
      });
    });
  </script>
</body>
</html>
```

### 方式二：CDN 引入

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SDK 示例</title>
</head>
<body>
  <button id="btn-report">点击上报</button>

  <!-- 通过 CDN 引入（使用 unpkg 或 jsdelivr） -->
  <script src="https://unpkg.com/@hulihan97/message-reporting/dist/index.global.js"></script>
  <!-- 或 -->
  <!-- <script src="https://cdn.jsdelivr.net/npm/@hulihan97/message-reporting/dist/index.global.js"></script> -->
  
  <script>
    // 初始化 SDK
    MessageReportingSDK.init({
      endpoint: 'https://api.example.com/report',
    });

    // 页面加载完成上报
    window.addEventListener('load', function() {
      MessageReportingSDK.report({
        event: 'page_load',
        loadTime: performance.now(),
      });
    });

    // 页面关闭前立即上报
    window.addEventListener('beforeunload', function() {
      MessageReportingSDK.reportImmediate({
        event: 'page_unload',
        stayDuration: Date.now() - pageStartTime,
      });
    });

    // 按钮点击上报
    document.getElementById('btn-report').addEventListener('click', function() {
      MessageReportingSDK.report({
        event: 'button_click',
        button: 'submit',
      });
    });
  </script>
</body>
</html>
```

### 方式三：动态加载

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SDK 动态加载示例</title>
</head>
<body>
  <script>
    // 动态加载 SDK
    (function() {
      var script = document.createElement('script');
      script.src = './dist/index.global.js';
      script.onload = function() {
        // SDK 加载完成后初始化
        MessageReportingSDK.init({
          endpoint: 'https://api.example.com/report',
        });

        // 初始化完成后可正常使用
        MessageReportingSDK.report({
          event: 'sdk_loaded',
        });
      };
      document.head.appendChild(script);
    })();
  </script>
</body>
</html>
```

### 方式四：结合业务逻辑

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>完整业务示例</title>
</head>
<body>
  <button id="btn-action">执行操作</button>

  <script src="./dist/index.global.js"></script>
  <script>
    // 页面进入时间
    var pageEnterTime = Date.now();

    // 初始化 SDK
    MessageReportingSDK.init({
      endpoint: 'https://api.example.com/report',
      gifEndpoint: 'https://api.example.com/report.gif',
      includeRuntimeInfo: true,
    });

    // 页面加载完成上报
    window.addEventListener('load', function() {
      MessageReportingSDK.report({
        event: 'page_view',
        url: window.location.href,
        referrer: document.referrer,
        loadTime: performance.now(),
      });
    });

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') {
        MessageReportingSDK.reportImmediate({
          event: 'page_hidden',
          stayDuration: Date.now() - pageEnterTime,
        });
      }
    });

    // 按钮点击上报
    document.getElementById('btn-action').addEventListener('click', function() {
      MessageReportingSDK.report({
        event: 'action_click',
        action: 'submit',
      });
    });

    // 错误捕获上报
    window.addEventListener('error', function(e) {
      MessageReportingSDK.report({
        event: 'js_error',
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
      });
    });
  </script>
</body>
</html>
```

## 📖 API 说明

### `init(options)`

初始化 SDK 配置。未传 `endpoint` 或传入空字符串会立即抛错。

**参数说明：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `endpoint` | `string` | 是 | - | 主上报地址 |
| `gifEndpoint` | `string` | 否 | `endpoint` | gif 兜底上报地址 |
| `headers` | `Record<string, string>` | 否 | `{ 'content-type': 'application/json' }` | 请求头配置 |
| `fetchCredentials` | `RequestCredentials` | 否 | `'same-origin'` | fetch 凭据模式 |
| `beaconMaxPayloadBytes` | `number` | 否 | `61440` (60KB) | beacon 最大体积 |
| `gifMaxPayloadBytes` | `number` | 否 | `1500` (1.5KB) | gif 最大体积 |
| `preferGifForSmallPayload` | `boolean` | 否 | `true` | 小包优先使用 gif |
| `includeRuntimeInfo` | `boolean` | 否 | `false` | 是否携带运行时环境信息 |

### `report(payload, options?)`

常规上报入口。会根据 payload 大小和环境能力选择 `gif` 或 `fetch`，页面隐藏场景也会自动优先考虑 `sendBeacon`。

**参数说明：**

- `payload`: 上报数据对象，必须为普通 JSON 对象
- `options.stage`: 可选，覆盖页面阶段（`'normal'` | `'hidden'` | `'unload'`）
- `options.transport`: 可选，强制指定发送通道（`'beacon'` | `'fetch'` | `'gif'`）

### `reportImmediate(payload, options?)`

即时上报入口。适用于页面隐藏、退出或希望优先使用 `sendBeacon` 的场景。

**参数说明：** 同 `report`

## 🔄 发送策略

### 通道选择逻辑

SDK 根据以下因素自动选择发送通道：

1. **页面阶段** - 页面隐藏/退出时优先 `sendBeacon`
2. **数据体积** - 小体积数据（≤1.5KB）优先 `gif`
3. **浏览器能力** - 检测是否支持 `sendBeacon`、`fetch`、`Image`

### 降级链路

| 首选通道 | 降级顺序 |
|----------|----------|
| `beacon` | `beacon` → `fetch` → `gif` |
| `fetch` | `fetch` → `beacon` → `gif` |
| `gif` | `gif` → `fetch` → `beacon` |

### 体积限制

- **beacon**: 最大 60KB（浏览器限制）
- **gif**: 最大 1.5KB（受 URL 长度限制）
- **fetch**: 无明确限制

## 🧠 智能特性

### 🔗 traceId 追踪

- 自动生成并持久化到 `localStorage`
- 跨页面复用同一追踪标识
- 每条上报数据自动携带 `traceId` 字段
- 支持 `crypto.randomUUID()` 或降级为时间戳+随机串

### 💻 运行时信息采集

开启 `includeRuntimeInfo` 后自动收集：

```json
{
  "ua": "Mozilla/5.0...",
  "browser": "chrome",
  "os": "windows",
  "hostApp": "browser",
  "isWechat": false,
  "isAlipay": false,
  "language": "zh-CN",
  "platform": "Win32",
  "onLine": true,
  "network": {
    "effectiveType": "4g",
    "downlink": 10,
    "rtt": 50,
    "saveData": false
  }
}
```

> ⚠️ 注意：开启后因数据包体积限制，gif 上报可能会失效。

### 📱 容器识别

自动识别以下宿主环境：

- `wechat` - 微信 H5 容器
- `alipay` - 支付宝 H5 容器
- `browser` - 普通浏览器

## 📝 类型导出

SDK 对外导出以下 TypeScript 类型：

- `InitOptions` - 初始化配置选项
- `ResolvedInitOptions` - 标准化后的内部配置
- `ReportOptions` - 上报覆盖选项
- `ReportPayload` - 上报数据结构
- `ReportResult` - 上报执行结果
- `TransportMode` - 发送通道类型
- `PageStage` - 页面阶段类型
- `ReportContext` - 上报上下文信息
- `RuntimeLike` - 运行时依赖接口
- `NetworkInfoLike` - 网络信息接口

## 📊 上报结果结构

每次上报返回 `ReportResult` 对象：

```ts
{
  ok: boolean,              // 是否成功
  transport: TransportMode, // 实际使用的通道
  payloadSize: number,      // 数据体积（字节）
  attemptedTransports: TransportMode[] // 尝试过的通道列表
}
```

## ⚠️ 注意事项

1. **必须先调用 `init`** - 未初始化直接调用 `report` 会抛错
2. **payload 必须为对象** - 不支持数组或原始值
3. **gif 通道限制** - 数据体积受 URL 长度限制，建议 ≤1.5KB
4. **localStorage 权限** - 某些浏览器可能限制 localStorage 访问，traceId 会降级为会话级
5. **跨域问题** - 确保上报地址支持跨域请求（CORS）
