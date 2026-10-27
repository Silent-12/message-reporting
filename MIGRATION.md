# SDK 独立仓库迁移记录

## 当前状态（2026-10-27）

按用户最新要求，SDK 已移除全部签名与摘要逻辑，只保留业务上报能力。下方 MD5 和 GIF 签名修复章节仅为历史执行记录，不代表当前功能。

已删除摘要模块、签名生成、安全字段注入、密钥及开关配置、签名专用 GIF 阈值、相关测试、`js-md5` 依赖及第三方许可文件。类型声明、README 示例、构建配置和锁文件同步清理。

当前保留 `init`、`report`、`reportImmediate`，fetch/beacon/GIF 发送及降级，traceId 和可选运行时信息。traceId 使用的 `crypto.randomUUID` 仅用于生成业务追踪标识；GIF 顶层 `_ts` 仅用于防缓存。SDK 不再自动注入其他安全字段，业务载荷中的自定义字段继续透传。

`npm run check` 通过：32 项业务测试，0 失败、0 跳过，lint 保留 2 个原有日志警告。原仓库不修改，新仓库不暂存、不提交、不推送。

- 日期：2026-10-27
- 来源：`https://github.com/Silent-12/sdk-reporting.git`
- 来源分支：`develop`
- 基准提交：`9141c1a236ed5b544c7e21ca823e0b84b3d5b826`（`feat(backend): 添加 Docker 支持和配置`）
- 原路径：`D:\kpwxproject\sdk-reporting\sdk`
- 新路径：`D:\kpwxproject\message-reporting`
- 迁移方式：白名单文件复制；新建本地 Git 仓库，默认分支 `main`，不继承历史。
- 版本：`@hulihan97/message-reporting` 从 `0.1.1` 升至 `0.2.0`；没有发布。
- 用户后续要求：仅初始化本地 Git，不创建提交、不推送，保留文件供审查；不配置远程。

## 初始迁移边界

`src/` 下的 5 个文件逐字节复制，`tsconfig.json`、`tsup.config.ts` 也原样保留。未复制原 SDK 的陈旧锁文件、产物、依赖或任何后端文件。原仓库不进行修改或清理，不启动其后端，避免触发数据库、日志等额外写入。自动错误捕获功能不在本次范围内。

## 对规格书的调整

1. 包使用 `type: module`，因此沿用 CommonJS 内容的配置命名为 `.eslintrc.cjs` 和 `commitlint.config.cjs`，避免 `module.exports` 在 ESM 中报错。ESLint 使用根 `tsconfig.json`，移除 Vue、React 等无关配置。
2. 在安装前初始化 Git，使 `prepare: husky` 可以正确设置 `.husky/_`。没有执行 `husky init`。
3. 提交钩子只运行 `lint` 与 `format` 检查，不自动格式化、不执行 `git add src`，保护原样迁移的源码与后续局部暂存。
4. 重新生成并保留独立的 `package-lock.json`。规格书的“安装后生成锁文件”与“首次提交不含锁文件”相互冲突，本仓库选择保留锁文件以支持 `npm ci`；没有复制旧锁文件。
5. `clean` 使用 Node.js 内置文件 API，支持 Windows 与其他平台。移除旧 `npm:push` 脚本，不复制发布凭据或 `.npmrc`。
6. 增加 Node.js 内置测试基建和有实际断言的传输回归测试；无需 Vitest/jsdom，后续错误捕获开发可以自行扩展。`prepublishOnly` 执行完整检查。
7. README 增补独立开发说明，修正模块导入示例为实际 npm 包名。
8. 文件清单增加测试、迁移记录与新锁文件，因此不使用规格书中固定的“17 个文件”作为最终验收条件。

## 源码 SHA-256

以下哈希记录原始复制内容，用于追溯本次迁移；不是对未来功能开发的冻结约束。

| 文件 | SHA-256 |
| --- | --- |
| `src/index.ts` | `0a6da089de221c4a6e469030b6d21f4bc9c1420d919d1fb7457be587c4f10d45` |
| `src/config.ts` | `36c17a76e640de6b1f34d99ccd1f543cb98ccb152372efa004862e1217c1602c` |
| `src/transports.ts` | `f4d58ed1a9559fc885e3fae293e744cfe410941796f48a0a8897adbf664fa151` |
| `src/utils.ts` | `0284b1e7b3b2f6303dc78eb6610ee29037066aaa2b3471e29f098e4d6b85c229` |
| `src/types/index.d.ts` | `8fb81e10bf88e5ff59a1bfe3395e09e18696e4c6141b84ade82a231b730cbfbd` |

## 初始迁移验证（MD5 修复前）

执行环境：Windows，Node.js `24.18.0`、npm `11.16.0`。包的最低 Node.js 声明为 `>=18`；本次没有在 Node.js 18 上复测。

| 检查 | 实际结果 |
| --- | --- |
| `npm install` | 成功，生成新锁文件，`prepare: husky` 配置 `.husky/_` |
| `npm run check` | 成功，包含类型、lint、格式、构建和测试 |
| ESLint | 0 error；2 个原有 `console.log` 警告，位于 `src/index.ts` |
| 测试 | 15 项通过，0 失败、0 跳过；包含真实本地 HTTP POST 接收验证 |
| 构建 | ESM/CJS/IIFE、sourcemap、双格式类型声明，共 8 个文件 |
| `npm pack --dry-run --json` | 清单断言通过，仅 `dist/` 8 项、`README.md`、`package.json`，共 10 项 |
| 提交前钩子 | 通过 `git hook run pre-commit` 实际执行 lint、格式检查；没有创建提交 |
| 提交信息钩子 | 合法信息通过，`bad message` 按预期被拒绝；没有创建测试提交 |
| SDK 源码一致性 | 5 个源码文件与原文件 SHA-256 相同；两份构建配置也逐字节一致 |
| 原仓库完整性 | 迁移前后 48 个已跟踪文件 SHA-256 全部一致；原工作区仍干净、HEAD 仍为基准提交 |
| Git 状态 | 新仓库初始化在 `main`，0 提交、0 暂存文件，未配置远程；所有交付文件保持未跟踪，供用户审查 |

没有执行 npm 发布、Git 推送或原后端启动。测试中的浏览器能力为替身，未进行真实浏览器联调。安装保留了原工具链的 ESLint 8 等版本范围，npm 的旧依赖弃用提示不影响上述检查，本次未做工具链大版本升级。

## 迁移发现的原有问题

原 `src/utils.ts` 中自实现的 `md5` 与标准 MD5 不一致（其中 `add32` 的高位累加不正确）。已直接只读执行原仓库 `utils.ts` 复现，源码哈希与迁移副本一致，确认不是本次迁移引入。固定输入：时间戳 `1700000000000`、nonce `HHHHHHHHHHHHHHHH`、traceId `migration-test-trace`、signingKey `test-key`；原实现结果为 `b758010067490100b47a01002c720000`，标准 MD5 为 `aa33a2d82cefedd731e5f8d2424a5e17`。

初始迁移阶段严格保留源码，没有修复签名算法；当时的回归测试锁定原始签名结果并标识非标准 MD5，只验证迁移兼容性。随后按用户要求进行了以下独立修复，当前测试已改为校验标准摘要。

## 后续修复：SDK MD5（2026-10-27）

用户明确要求修复 SDK 的 MD5 实现并补齐标准测试，因此当前代码在原样迁移基线上有以下变化：

- 移除 `src/utils.ts` 中手写的 MD5、UTF-8 编码及错误的 `add32`，`createSignature` 改为调用内部 `src/md5.ts` 的 `computeMd5`。
- 固定使用 `js-md5@0.9.2`。内部包装先通过 `TextEncoder` 转换为 UTF-8 字节，未配对代理字符替换为 U+FFFD，与 `node:crypto` 的字符串编码保持一致。
- 将库作为开发/构建依赖，通过 tsup 的 `noExternal` 显式打入三种产物，继续不声明外部运行时依赖；包内附带第三方许可。
- 签名输入仍为 `timestamp + nonce + traceId + signingKey`，公共 API 和字段位置保持不变。修正后的摘要不兼容旧错误实现，但可与标准 MD5 接收端匹配。
- 新增 RFC 1321 Appendix A.5 全部 7 个固定测试向量；补充中文、emoji、组合字符、NUL、未配对代理字符、55/56/64 等字节分块边界、百万字节输入，以及原 `abCD` / `abXY` 碰撞回归。
- 签名单元测试与 `node:crypto` 交叉验证；CJS/IIFE 的 fetch、beacon、GIF 载荷均断言标准签名，ESM 经真实本地 HTTP 接收器验证标准签名。
- `npm run check` 通过，共 56 项测试，0 失败、0 跳过；lint 保留 2 个原有 `console.log` 警告。三种构建与类型声明仍输出 8 项。

上述 SHA-256 表仍代表初始复制基线，不代表修复后的文件。此次没有修改原仓库或后端，没有修复业务字段未参与签名及 GIF 服务端字段解析问题，也没有创建 Git 提交、配置远程或发布包。

## 后续修复：GIF 顶层签名字段（2026-10-27）

用户要求继续修复 GIF 通道签名字段位置不匹配，并明确禁止修改旧仓库和提交代码。此阶段仅调整新仓库：

- `buildGifRequestUrl` 增加内部签名模式参数；发送层按 SDK 签名配置传入，关闭签名时不根据业务载荷猜测是否启用。
- 签名模式下将 `_ts`、`_nonce`、`_sign`、`traceId` 从已序列化的 GIF 载荷同步到顶层查询参数，同时保留 `data` JSON 内的原字段。
- 顶层 `_ts` 使用原签名时间戳，发送和降级时不重新生成，避免缓存时间戳与签名时间戳不一致。
- 统一处理查询参数：保留非保留参数及其重复值，替换 SDK 管理的同名参数；兼容相对路径、协议相对路径、已有查询和 URL 片段。签名关闭时保留 `data` 加防缓存 `_ts` 的行为。
- 新增 GIF URL 单元测试，扩展 CJS/IIFE 签名与降级测试，并使用独立本地 HTTP 接收器实际接收 GET 请求，从顶层查询参数校验标准 MD5 和时间戳。测试不依赖旧仓库，也不启动其后端、数据库或 Redis。
- `npm run check` 通过，共 68 项测试，0 失败、0 跳过；lint 仍只有 2 个原有 `console.log` 警告，构建仍输出 8 项。

该修复兼容原接收端从顶层查询参数读取 GET 签名字段的约定，未修改原接收端代码。业务字段未参与签名的问题仍保持原状。
