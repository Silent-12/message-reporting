# 目标 02：CID 与上报策略

> 状态：SDK 初始化、后端接口与单元测试已实现；真实 MySQL/Redis、浏览器和部署联调尚未验证。依赖[目标 01](目标01-协议与安全边界.md)共同协议。

## 目标与职责

SDK 初始化后取得与当前服务端和应用对应的服务端签发 CID，再请求是否允许上报；服务端负责签发绑定、上报策略、撤销、审计及限流。SDK 对未明确允许的状态不发送或缓存事件。

前置条件：管理员通过 AppPulse 后端管理接口提交项目名称，由后端随机生成并持久化仅含小写字母与数字混合的 appId；生成规则见目标 01。后台页面尚未实现。SDK 只使用分配的 appId，不负责创建项目或生成标识；格式合规但不存在的 appId 不能获得 CID。

## 接口与行为约定

### 按 APPID 下发采集配置（v0.3.0）

- SDK 每次非并发 `init` 均先签发或复用 CID，再查询 `POST v1/admission`；仅准入允许时调用 `POST v1/config`，请求体严格为 `{appId,cid}`。配置接口独立验证 CID 归属、有效性及当前准入，使用准入接口的故障关闭限流与统一响应。`data` 为完整配置，缺字段、请求失败或响应非法时 SDK 停止采集并返回 `failed`；所有采集来源关闭时返回 `disabled`。同目标并发初始化共用过程，重复初始化暂停旧采集后重新查询准入与配置。
- 配置结构为 `{eventUrl,browserKinds,console:{enabled,levels,fields},environmentFields,contextEnabled}`。`eventUrl` 为 `null` 或完整 HTTP(S) 事件请求地址，允许独立域名和查询参数，不允许凭据、片段或超过 2048 字符；`null` 使用 `{serverUrl}/v1/events`。`browserKinds` 只含 `javascript/unhandledrejection/img/script/resource`；控制台级别只含 `debug/info/warn/error`，可选字段只含 `name/stack/pagePath`；环境字段只含 `userAgent/online/effectiveType`。数组不允许重复值，控制台开启时须至少选一个级别。
- 项目无采集配置记录时，服务端返回五类浏览器错误和三个环境字段开启、`contextEnabled:true`、控制台关闭、`eventUrl:null` 的默认值。后台 `GET/PATCH v1/admin/log-report-projects/:appId/config` 在现有上报配置页面读取、保存完整配置，使用独立接口编码 `log-report.projects.config.read` 与 `log-report.projects.config`，分别绑定现有查看与修改上报配置的资源权限；字段多选使用 `ElCheckboxGroup` 和 `ElCheckbox`。
- AppPulse 事件接收端在解密后、保存前按 APPID 校验当前配置：拒绝关闭的浏览器类型或控制台级别、被禁止的控制台可选字段、环境字段和上下文。控制台事件由 `kind:'other'` 加合法 `level` 标识，`name` 可省略，提供时须为 `console.<级别>`。配置不匹配使用独立错误码 `CONFIG_REJECTED`，SDK 只丢弃当前事件并继续采集；策略或 CID 拒绝仍使用 `NOT_ALLOWED` 并停止发送。独立上报地址的接收端需适配相同的加密信封、CID 与配置约束，并允许接入页面跨域请求。SDK 不定时刷新配置；后台修改在下一次初始化后影响 SDK 采集，AppPulse 接收端校验立即生效。

- `init` 异步校验配置，读取以规范化 `serverUrl` 和 `appId` 为命名空间的本地持久存储；不同服务端、路径前缀或应用不得共用 CID。服务端地址规范化规则在实现中固定并由两端测试，避免等价地址重复申请；不将 CID 或业务身份输出到日志。
- 找不到合法 CID 时调用 `v1/cids`；服务端先持久化签发记录，再以 HTTP 200 的统一响应 `data.cid` 返回。SDK 校验后成功写入持久存储且可重新读取，再调用 `v1/admission`。已有 CID 直接查询上报策略；只有 HTTP 200、响应合规且 `data.allowed === true` 才继续查询采集配置，`data.allowed === false` 表示正常禁止上报。`v1/cids` 的请求体仅含 `appId`，`v1/admission` 与 `v1/config` 的请求体仅含 `appId`、`cid`；内容类型须为 `application/json`，多余字段按 400、非 JSON 内容类型按 415 拒绝。
- 服务端记录 CID、所属 appId、服务端创建时间、签发来源 IP、可获得的 Origin/UA、有效或撤销状态及撤销时间/原因。创建和撤销时间按后端规范采用 Unix 秒，签发来源 IP 复用 `getClientIp`；这些字段不由请求体指定，也不随签发响应返回。Origin/UA 限长且可缺失；不收集完整 Referer，不作为可信身份。详见目标 01。
- CID 不设累计事件数上限，不因累计量失效或吊销。签发 IP 仅作追溯与申请限流，不绑定后续使用；切换网络/IP 后仍可用，但仍须通过归属、状态、上报策略、协议及频率校验。
- 项目是跨业务模块的通用对象；日志上报策略由日志上报模块单独管理。上报策略支持全部允许（黑名单除外）、仅白名单与黑名单拒绝三种；项目未配置策略时默认使用白名单，每个项目独立维护黑白名单，黑名单在所有策略下均拒绝。CID 已在白名单时添加到黑名单返回 409 和友好提示，须先手动移除；反向同理，事务保证并发互斥。后续事件请求须独立校验最新策略。允许被撤销后，SDK 收到 `NOT_ALLOWED` 即停止发送；恢复依靠应用再次初始化，不做定时刷新。

### 后台管理接口

以下路径均追加在实际 API 前缀后，使用后台 Bearer 认证和接口权限。创建项目返回 `data:{appId}`，其他写操作返回 `data:null`：

| 方法与路径 | 请求或用途 |
| --- | --- |
| `POST v1/admin/projects` | `{name}`，创建通用项目 |
| `GET v1/admin/projects` | `page`、`pageSize`，分页查询项目，列表项为 `{appId,name}` |
| `PATCH v1/admin/projects/:appId` | `{name}`，修改名称 |
| `GET v1/admin/log-report-projects/:appId/policy` | 查询项目上报策略，返回 `{reportPolicy}` |
| `PATCH v1/admin/log-report-projects/:appId/policy` | `{reportPolicy:'all'\|'white'\|'black'}`，修改上报策略 |
| `POST v1/admin/log-report-projects/:appId/cids` | 请求体支持 `page`、`pageSize`、`cid`、`issueIp`、`status`，分页查询 CID；CID 与 IP 完整精确匹配，CID 区分大小写，状态为 `valid`（有效）或 `revoked`（已撤销）；列表项 `lastReportTime` 为最近成功保存的未删除日志的服务端接收时间（Unix 秒），无日志时为 `null` |
| `PATCH v1/admin/log-report-projects/:appId/cids/list` | `{cid,list:'none'\|'white'\|'black'}`，设置或移除名单 |
| `POST v1/admin/log-report-projects/:appId/cids/revoke` | `{cid,reason}`，撤销 CID |

接口权限由现有 RBAC 分配，通用项目管理和日志上报管理分别授权。CID 出现在请求体或受保护响应中，不放在 URL。

- 服务端按 appId 和可信客户端 IP 限制成功签发，默认滚动 24 小时最多 10 个 CID；另按 IP 分别限制进入 SDK 控制器的签发尝试和上报策略查询，默认每分钟 60 次和 120 次。正文在进入控制器前解析失败不会计入协议限流。三个阈值集中维护在后端日志上报协议常量中，拒绝返回 `RATE_LIMITED`；事件请求频率限制由目标 03 实现。
- 服务端以 HTTP 401、`data.errorCode: 'CID_INVALID'` 表示未签发、归属不符或已撤销。SDK 停止发送；删除前检查存储中的 CID 是否仍与被拒绝的 CID 一致，以降低迟到响应删除新 CID 的风险。`localStorage` 的检查和删除不是跨标签页原子操作，跨标签页竞争仍可能发生，需在验收中记录。本次初始化或发送不自动重新申请，应用稍后重新初始化时才申请新 CID。若删除失败则继续保持不可上报。普通 401、网络失败、429 或 `NOT_ALLOWED` 不删除 CID，避免不必要的重复签发。
- 同一页面同一监控目标（规范化 `serverUrl` 与 `appId` 相同）的并发 `init` 共用一次初始化过程；不同监控目标的并发初始化返回冲突，已完成初始化的同目标重复调用不重复注册监听器，并采用最新传入的 `getContext`。停止后可以重新初始化；使用代次控制，停止或重启前的迟到响应不能重新启用旧状态。跨标签页同时首次初始化可能分别签发 CID，服务端限流与审计需考虑这一情况。

## 失败处理与验收

- 签发和上报策略请求按目标 01 单次 5 秒超时，网络错误、超时及 5xx 按 1、2、4 秒指数退避最多重试 3 次；4xx、无效响应、参数或存储错误以及 `allowed:false` 不重试。重试耗尽或明确拒绝后保持不可上报，初始化返回明确状态，不生成本地替代 CID 或明文发送。
- 签发响应丢失时重试可能产生多个已持久化 CID；迟到响应不能覆盖本次选择的 CID，未使用记录以及已签发但本地写入失败的记录按服务端留存策略处理。必要签发存储、限流或上报策略校验不可用时，服务端返回 503、通用提示及 `data:null`；有限重试期间不能把组件故障当作允许。
- 覆盖首次签发及刷新复用、来源信息记录与跨 IP 使用、同 CID 无累计事件额度、服务端持久化失败不返回 CID、签发响应丢失和迟到导致的多记录、5 秒超时及退避重试上限、应用与地址隔离、存储抛错、签发成功但本地写入失败、限流不重试、无效或吊销 CID、普通 401 不清理 CID、上报策略允许/禁止上报、服务端配置变更、并发初始化、停止后的迟到响应和再次初始化。
- 使用真实接收服务验证签发绑定、可信代理 IP、限流和并发行为；真实持久化环境、隐私告知及跨标签页行为未验证前须记录边界。CID 不证明真实用户身份。
