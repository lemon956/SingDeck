# SingDeck 产品需求文档

版本: 0.2  
日期: 2026-05-06  
阶段: 立项需求梳理  
产品定位: 面向单用户、单 sing-box 实例、本地使用场景的免本地部署 Web 面板

## 1. 背景

sing-box 以 JSON 配置为核心，配置域覆盖 `log`、`dns`、`inbounds`、`outbounds`、`route`、`rule_set`、`services`、`experimental` 等模块。运行时管理主要依赖 `experimental.clash_api` 暴露的 Clash 兼容控制接口，包括节点查看、策略组切换、连接管理、流量统计和日志查看。

SingDeck 的目标是提供一个无需用户本地安装面板程序的 Web 工具。用户可以通过浏览器直接访问面板，再由浏览器连接到自己的单个 sing-box Clash API。第一阶段优先解决运行时查看和控制，后续再扩展配置编辑、订阅转换、规则编排和 Linux 部署辅助能力。

当前参考基线是 zashboard。zashboard 已经提供基于 Clash API 的 PWA 面板能力，支持 sing-box、mihomo 和 Clash 后端，并覆盖连接页、节点测速、日志、规则、流量和 URL 参数初始化。SingDeck 不需要为了“管理后台化”而扩展角色、权限、多实例、云端同步等能力，重点应放在单实例 sing-box 使用体验、必要配置辅助和比 zashboard 更贴合 sing-box 配置模型的功能上。

## 2. 产品目标

1. 用户无需本地部署面板服务即可使用核心管理能力。
2. 支持连接一个 sing-box 实例，并完成运行状态查看、节点切换、延迟测试、连接管理和日志查看。
3. 对浏览器直连本地或私网 API 的限制给出明确诊断，包括鉴权、CORS、Private Network Access 和 `secret` 配置问题。
4. 提供必要配置校验能力，帮助用户发现会直接阻塞面板使用的问题，例如 JSON 语法错误、Clash API 未启用、控制器地址缺失。
5. 为 P1 及后续的配置编辑、订阅管理、运行时分析和策略编排预留清晰的数据模型和模块边界。

## 3. 非目标

P0 阶段不实现以下能力:

1. 不托管或中转用户流量。
2. 不默认提供云端代理或穿透服务。
3. 不做账号、角色、权限、团队协作或审计。
4. 不管理多个 sing-box 实例。
5. 不承诺覆盖 sing-box 全量配置字段的可视化编辑。
6. 不重复实现 sing-box 启动阶段已经完成的深度配置校验。
7. 不直接修改远端主机上的 sing-box 配置文件，除非后续引入明确的 agent 或远程管理方案。

## 4. 用户模型

SingDeck 只有一个用户角色: 当前浏览器使用者。该用户拥有所有功能权限，不需要登录、授权分级、管理员、只读用户或团队空间。

| 用户 | 需求 |
|---|---|
| 当前使用者 | 管理一个 sing-box 实例，快速查看连接状态、切换节点、测速、查看日志、断开连接、做必要配置辅助 |

## 5. 运行模式

### 5.1 纯前端模式

面板以静态 Web 应用形式发布，可部署到 CDN、对象存储、Pages 或任何静态站点服务。用户浏览器直接请求 sing-box 的 Clash API。

优点:

1. 部署简单，成本低。
2. 面板服务端不接触用户 API secret。
3. 可离线缓存为 PWA。

限制:

1. 受浏览器 CORS 和 Private Network Access 限制。
2. 无法主动访问用户内网，必须由用户浏览器发起请求。
3. 无法在云端定时更新订阅或持续监控。P0 接受这个限制。

### 5.2 URL 参数启动模式

为了贴近 zashboard 的使用习惯，SingDeck 应支持通过 URL 参数初始化控制器连接信息，例如协议、主机、端口、路径和 `secret`。该能力用于快速打开面板和迁移现有使用方式。

URL 参数中的 `secret` 会出现在浏览器历史、书签或分享链接中，因此界面需要提示风险。P0 不禁止这种用法，但默认推荐用户在设置页输入并保存到当前浏览器。

## 6. P0 MVP 需求

P0 目标是完成一个可实际使用的单实例 sing-box 运行时面板。验收重点是能连接真实实例，能展示关键状态，能切换 selector，能查看和关闭连接，能看到日志，并能清楚解释连接失败原因。

### 6.1 项目入口

| 项 | 说明 |
|---|---|
| 功能描述 | 提供 Web 面板，无需本地部署。支持浏览器直接打开和 PWA 安装。 |
| 用户故事 | 用户访问 SingDeck 网站，即可连接自己的 sing-box 控制器并开始管理。 |
| 核心功能 | 静态站点发布、PWA manifest、离线 shell 缓存、当前控制器配置本地保存、URL 参数初始化。 |
| 验收标准 | 首次访问可正常加载；刷新后当前控制器配置仍存在；无网络时可打开基础界面。 |
| 风险 | PWA 不代表 API 可离线访问，需在界面上区分面板离线和实例离线。 |

### 6.2 控制器设置

| 项 | 说明 |
|---|---|
| 功能描述 | 配置当前 sing-box Clash API 连接信息。 |
| 字段 | 控制器地址、`secret`、备注、默认测试地址。 |
| 控制器地址格式 | `http://127.0.0.1:9090`、`http://192.168.1.1:9090`、`https://example.com/api`。 |
| 本地存储 | P0 使用浏览器本地存储。`secret` 需要明确提示只保存在当前浏览器。 |
| 验收标准 | 用户可配置一个控制器；刷新后继续使用该控制器；修改地址或 secret 后重新检测连接。 |
| 安全要求 | secret 输入默认隐藏；诊断信息复制时默认脱敏。 |

### 6.3 连接检测

| 项 | 说明 |
|---|---|
| 功能描述 | 检测 Clash API 可达性、鉴权状态、CORS 和 Private Network Access 问题。 |
| 检测项 | URL 合法性、根路径响应、`/version`、鉴权头、CORS 响应、私网访问权限。 |
| 失败分类 | 地址不可达、协议错误、证书错误、401/403、CORS 阻断、PNA 阻断、API 未开启。 |
| 用户提示 | 针对 sing-box `experimental.clash_api` 给出最小配置建议。 |
| 验收标准 | 对错误分类展示明确原因和修复建议，不只显示 `fetch failed`。 |

### 6.4 概览看板

| 项 | 说明 |
|---|---|
| 功能描述 | 展示当前实例运行状态和关键指标。 |
| 指标 | API 连接状态、sing-box 版本、运行模式、上传速率、下载速率、总上传、总下载、活动连接数。 |
| 数据来源 | Clash API 的 version、configs、traffic、connections 等接口能力。 |
| 刷新策略 | 低频信息手动刷新；流量和连接数支持实时流或 1 秒轮询降级。 |
| 验收标准 | 网络波动时界面不崩溃；断开后显示最后更新时间和重连入口。 |

### 6.5 节点列表

| 项 | 说明 |
|---|---|
| 功能描述 | 展示 outbounds 和策略组，帮助用户理解当前代理结构。 |
| 展示字段 | tag、类型、当前选择、延迟、历史延迟、可用状态、所属策略组。 |
| 筛选 | 协议类型、标签关键词、是否策略组、是否可选、延迟区间、可用性。 |
| 排序 | 名称、延迟、类型、最近测试时间。 |
| 验收标准 | selector、urltest、direct、block 和常见代理 outbound 均能合理展示。 |

### 6.6 节点选择

| 项 | 说明 |
|---|---|
| 功能描述 | 控制 selector outbound，切换当前使用节点。 |
| 前置条件 | 目标 outbound 类型必须支持通过 Clash API 切换。sing-box selector 当前通过 Clash API 控制。 |
| 交互 | 在策略组详情中选择目标节点，提交后刷新当前选择和连接状态。 |
| 选项 | 可提示是否中断已有连接，取决于 sing-box 配置中的 `interrupt_exist_connections`。 |
| 验收标准 | 切换成功后 selector 当前值更新；失败时展示 API 返回原因。 |

### 6.7 延迟测试

| 项 | 说明 |
|---|---|
| 功能描述 | 对节点或策略组发起延迟测试，并允许不同节点或策略组配置不同测试地址。 |
| 测试地址层级 | 面板默认测试地址、当前控制器默认测试地址、策略组测试地址、单节点测试地址。 |
| 默认建议 | 若未配置，使用 sing-box urltest 默认思路的 HTTP 204 类地址；用户可覆盖。 |
| 展示字段 | 延迟毫秒、测试时间、测试 URL、失败原因、超时状态。 |
| 批量测试 | 支持按筛选结果批量测试，限制并发数，避免压垮本地 API 或节点。 |
| 验收标准 | 同一策略组可使用独立测试 URL；失败结果可区分超时、DNS、TLS、HTTP 错误。 |

### 6.8 连接管理

| 项 | 说明 |
|---|---|
| 功能描述 | 查看当前连接，按域名、IP、规则、出站过滤，支持断开连接。 |
| 展示字段 | 连接 ID、源地址、目标地址、目标端口、网络类型、上传、下载、链路、匹配规则、最终 outbound、创建时间。 |
| 操作 | 断开单个连接、断开全部连接、按过滤条件批量断开。 |
| 风险提示 | 批量断开会影响当前所有相关会话，需要二次确认。 |
| 验收标准 | 能稳定展示活动连接；断开后列表更新；过滤不影响原始数据。 |

### 6.9 配置校验

| 项 | 说明 |
|---|---|
| 功能描述 | 只校验会直接影响面板连接和基础编辑的问题，不重复 sing-box 启动时已有的深度校验。 |
| 校验范围 | JSON 语法、`experimental.clash_api` 是否存在、`external_controller` 是否可识别、配置中是否能推导控制器地址。 |
| 轻量提示 | 如果 `external_controller` 监听 `0.0.0.0` 且未设置 `secret`，提示它会让可达者读连接、读日志、切节点和断连接。 |
| 输出 | 错误、提示两级；错误用于阻塞导入，提示只辅助用户判断。 |
| 验收标准 | 非法 JSON 会被阻止；缺少 Clash API 配置会提示无法作为运行时面板连接；其他 sing-box 配置合法性不做深度判断。 |

### 6.10 日志查看

| 项 | 说明 |
|---|---|
| 功能描述 | 查看 sing-box Clash API 暴露的实时或轮询日志。 |
| 能力 | 日志流连接、级别过滤、关键词搜索、暂停滚动、清空当前视图、复制上下文。 |
| 降级 | WebSocket 不可用时提示原因，并尝试可用的 HTTP 流或轮询方式。 |
| 验收标准 | 大量日志不会导致界面明显卡顿；断线后可手动重连。 |

### 6.11 安全提示

| 项 | 说明 |
|---|---|
| 功能描述 | 本地使用场景下的最小安全提示。 |
| 触发条件 | `external_controller` 为 `0.0.0.0` 且空 `secret`；URL 参数中携带 `secret`；诊断报告包含敏感字段。 |
| 交互 | 只做明确提示，不强制阻断保存。 |
| 验收标准 | 面板不做复杂安全策略，但避免用户在无感状态下把控制接口暴露给同网段或公网可达者。 |

## 7. P1 配置管理

P1 目标是让用户不仅能看运行状态，还能维护配置。该阶段建议采用“JSON 高级编辑器优先，表单化编辑逐步覆盖”的策略，避免为了覆盖全部字段而牺牲稳定性。

### 7.1 可视化配置编辑器

| 项 | 说明 |
|---|---|
| 范围 | 表单化编辑 `inbounds`、`outbounds`、`dns`、`route`。 |
| 设计原则 | 表单覆盖高频字段；低频字段保留 JSON 扩展区。 |
| 关键能力 | 新增、复制、删除、排序、启停片段、字段说明、默认值提示。 |
| 验收标准 | 用户可从零创建一个基础 mixed 入站、selector/urltest 出站、DNS 和 route 配置。 |

### 7.2 JSON 高级编辑器

| 项 | 说明 |
|---|---|
| 范围 | Monaco 或 CodeMirror 编辑器。 |
| 能力 | 语法高亮、格式化、折叠、错误定位、JSON path、搜索替换。 |
| 校验 | 接入 P0 必要校验；后续可接入版本化 schema 作为编辑提示，不作为深度启动校验。 |
| 验收标准 | 编辑器中的 JSON 语法错误和 Clash API 必要配置问题能同步展示到问题面板。 |

### 7.3 Inbound 管理

| 类型 | P1 支持建议 |
|---|---|
| mixed | 优先支持，适合桌面代理入口 |
| socks | 支持监听地址、端口、认证 |
| http | 支持监听地址、端口、认证 |
| tun | 支持基础字段，复杂平台字段放入高级 JSON |
| tproxy/redirect | 以 Linux/旁路由模板形式支持 |

### 7.4 Outbound 管理

| 类型 | P1 支持建议 |
|---|---|
| direct/block | 基础支持 |
| selector | 完整支持 outbounds、default、interrupt 配置 |
| urltest | 支持 outbounds、url、interval、tolerance、idle_timeout |
| wireguard | 支持高频字段，注意 sing-box 新版本 endpoint 变化 |
| shadowsocks/trojan/vless/hysteria2/tuic | 支持节点字段、TLS 字段和传输字段的常用组合 |

### 7.5 DNS 管理

| 功能 | 说明 |
|---|---|
| DNS server | 管理 local、hosts、tcp、udp、tls、https、http3、quic、fakeip 等常见 server |
| DNS rule | 支持 domain、domain_suffix、query_type、clash_mode、rule_set、outbound 等条件 |
| FakeIP | 管理 fakeip 地址池和持久化提示 |
| 缓存 | 展示缓存相关字段和风险提示 |
| ECS | 支持 client_subnet 的显式配置和隐私提示 |

### 7.6 路由规则

| 功能 | 说明 |
|---|---|
| 条件编辑 | domain、domain_suffix、domain_keyword、domain_regex、ip_cidr、process_name、process_path、rule_set、clash_mode、network 等 |
| 动作编辑 | outbound、route action 相关字段 |
| 排序 | 支持拖拽排序，展示命中优先级 |
| 引用检查 | outbound 和 rule_set 引用不存在时给出提示，不做复杂阻断 |

### 7.7 Rule Set 管理

| 功能 | 说明 |
|---|---|
| 类型 | inline、local、remote |
| 格式 | source、binary，按文件扩展名辅助识别 |
| 远程规则 | url、update_interval、http_client |
| 版本兼容 | `download_detour` 在 sing-box 1.14.0 起废弃，后续应迁移到 `http_client` |

### 7.8 模板系统

| 模板 | 内容 |
|---|---|
| 纯客户端 | mixed 入站、selector/urltest、基础 DNS、国内外分流 |
| TUN 模式 | tun 入站、自动路由、DNS 劫持、平台差异提示 |
| 透明代理 | tproxy/redirect、Linux 路由表提示 |
| 旁路由 | 局域网网关、DNS、FakeIP、规则集组合 |

### 7.9 配置版本

| 功能 | 说明 |
|---|---|
| 快照 | 每次保存生成命名快照 |
| Diff | JSON 结构化 diff，按模块折叠 |
| 回滚 | 回滚到历史版本，回滚前生成当前快照 |
| 脱敏 | diff、复制诊断信息时隐藏 secret、password、private_key、token |

## 8. P1 订阅与规则

### 8.1 订阅解析

| 项 | 说明 |
|---|---|
| 输入 | 订阅 URL、剪贴板、文件导入 |
| 输出 | sing-box outbounds 或中间节点模型 |
| 支持协议 | shadowsocks、trojan、vless、hysteria2、tuic 等常见代理节点 |
| 验收标准 | 解析失败时能指出具体节点和字段原因。 |

### 8.2 订阅更新

| 功能 | 说明 |
|---|---|
| 手动更新 | 用户点击更新订阅并预览差异 |
| 定时更新 | 纯前端模式只能在用户打开面板时检查；P1 不做后台定时任务 |
| 自定义保留 | 保留用户改名、分组、测试地址、排序和排除规则 |

### 8.3 节点清洗

| 功能 | 说明 |
|---|---|
| 去重 | 按 server、port、协议、凭证摘要识别 |
| 重命名 | 地区、倍率、运营商、协议标签 |
| 分组 | 按地区、协议、订阅来源、倍率自动分组 |
| 排除 | 支持关键词、地区、倍率、协议过滤 |

### 8.4 策略组生成

| 功能 | 说明 |
|---|---|
| selector | 人工选择策略组 |
| urltest | 自动测速策略组 |
| fallback | 若 sing-box 当前版本或兼容层可用则支持，否则以替代方案说明 |
| 模板 | 自动生成“手动选择”“自动选择”“故障备用”等组合 |

### 8.5 规则冲突提示

| 检查 | 说明 |
|---|---|
| 重复规则 | 完全重复或等价规则提示 |
| 顺序遮蔽 | 前置规则覆盖后置规则时提示 |
| 引用缺失 | outbound、rule_set、inbound 不存在时提示 |
| 不可达 outbound | 节点不存在、策略组空、循环引用时提示 |

## 9. P2 运行时增强

### 9.1 实时流量图

展示上传/下载速率、连接趋势、节点流量排行。需要支持 WebSocket 实时流，失败时降级为轮询。图表需限制历史点数量，避免长时间打开后内存增长。

### 9.2 连接详情

展示目标地址、协议嗅探、匹配规则、入站、出站链路、上传下载、创建时间和连接持续时间。支持从连接跳转到对应规则、节点或日志过滤。

### 9.3 节点质量

记录延迟、失败率、最近成功时间、最近失败原因、地区识别和订阅来源。P2 数据仍保存在当前浏览器，不引入账号同步。

### 9.4 自动切换

提供建议式自动切换，不在 P2 默认替用户频繁切换。可根据延迟、失败率和用户偏好给出推荐节点，用户确认后执行。

### 9.5 规则命中统计

统计规则和规则集命中情况。若 Clash API 暴露的规则信息不足，需要基于连接快照中的 rule 字段进行近似统计，并在文档中标注为运行时观测值。

### 9.6 DNS 观测

展示 DNS 查询记录、DNS server 命中、FakeIP 映射和失败原因。需要确认 sing-box 当前 API 暴露能力，不足部分只能通过日志解析或后续 agent 实现。

### 9.7 故障诊断

诊断入口按症状组织:

1. 面板连不上 API。
2. API 鉴权失败。
3. 节点超时。
4. DNS 解析失败。
5. 规则未按预期命中。
6. 切换节点后旧连接仍走原链路。

每个诊断项输出“检测结果、可能原因、修复建议、可复制报告”。

## 10. P3 高级能力

### 10.1 配置模拟

用户输入域名、IP、端口、协议、入站 tag、clash_mode，面板预判 DNS、Route 和最终 Outbound。P3 初期可基于本地配置静态模拟，不承诺完全等价于 sing-box 内核运行结果。

### 10.2 策略编排

提供拖拽式规则排序和策略组关系图。重点解决复杂 selector、urltest、rule_set 和 route 之间的可视化理解问题。

### 10.3 Linux 支持

| 功能 | 说明 |
|---|---|
| systemd 检查 | 提供 sing-box 服务状态检查命令和结果粘贴解析 |
| 配置路径 | 支持常见路径 `/etc/sing-box/config.json`、多文件目录 |
| 权限提示 | TUN、tproxy、redirect、capability、iptables/nftables 相关提示 |
| 旁路由向导 | 网关、DNS 劫持、转发、防火墙规则检查 |
| 日志辅助 | 支持解析 `journalctl -u sing-box` 输出 |

P3 的 Linux 支持如果需要直接执行命令，必须引入本地 agent 或 SSH/远程执行能力。纯前端模式只能提供说明、配置生成和日志粘贴分析。

### 10.4 API 兼容层

兼容 Clash Meta/Yacd 风格 API 展示，降低用户迁移成本。需要把 sing-box API 返回转换成面板统一模型，避免 UI 直接绑定某个实现的字段。

## 11. 数据模型草案

### 11.1 ControllerConfig

| 字段 | 类型 | 说明 |
|---|---|---|
| controllerUrl | string | Clash API 地址 |
| secret | string | secret，仅保存在当前浏览器 |
| note | string | 备注 |
| defaultTestUrl | string | 当前控制器默认测试地址 |
| updatedAt | string | 更新时间 |

### 11.2 ProxyNode

| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | outbound tag |
| type | string | outbound 类型 |
| group | string | 所属策略组 |
| delay | number | 最近延迟 |
| alive | boolean | 是否可用 |
| testUrl | string | 节点级测试地址 |
| history | array | 延迟历史 |

### 11.3 Connection

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 连接 ID |
| source | string | 源地址 |
| destination | string | 目标地址 |
| network | string | tcp/udp |
| upload | number | 上传字节 |
| download | number | 下载字节 |
| rule | string | 匹配规则 |
| outbound | string | 最终出站 |
| chains | array | 出站链路 |

### 11.4 ValidationIssue

| 字段 | 类型 | 说明 |
|---|---|---|
| severity | error/info | 严重程度 |
| path | string | JSON path |
| message | string | 问题说明 |
| suggestion | string | 修复建议 |

## 12. API 依赖

| 能力 | 依赖 |
|---|---|
| 鉴权 | `Authorization: Bearer <secret>` |
| 版本信息 | Clash API version 能力 |
| 模式读取/切换 | Clash API configs 能力 |
| 节点列表 | Clash API proxies 能力 |
| selector 切换 | Clash API proxies 更新能力 |
| 延迟测试 | Clash API proxy delay 能力，或基于 urltest 配置能力 |
| 连接列表 | Clash API connections 能力 |
| 断开连接 | Clash API connections 删除能力 |
| 流量 | Clash API traffic 能力 |
| 日志 | Clash API logs 能力 |

实际接口路径需以当前 sing-box 版本的 Clash API 实现为准，前端应集中封装 API client，避免业务组件直接拼接路径。

## 13. 安全与隐私

SingDeck 按本地个人使用场景设计，不做企业级安全、权限、审计或复杂风控。P0 只保留必要安全提醒。

1. `secret`、订阅地址、节点密码、私钥等敏感字段在诊断、diff、复制信息中默认脱敏。
2. 纯前端模式下，敏感信息只保存在当前浏览器。
3. URL 参数携带 `secret` 时提示它可能进入浏览器历史、书签或分享链接。
4. 对 `0.0.0.0` 且空 `secret` 的 API 暴露给出明确提示，但不强制阻断保存。
5. 该提示的理由是 Clash API 可读取连接和日志、切换节点、断开连接；如果监听地址可被同网段或公网访问，空 `secret` 会让可达者直接控制当前 sing-box。
6. 公网 HTTPS 面板访问私网 HTTP API 时，需要提示 CORS 和 Private Network Access 配置要求。这是连接可用性问题，不作为复杂安全体系处理。

## 14. 兼容性要求

| 项 | 要求 |
|---|---|
| 浏览器 | 最新 Chrome、Edge、Firefox、Safari |
| 移动端 | 基础查看可用，复杂编辑优先桌面端 |
| sing-box 版本 | P0 优先支持当前稳定版本及近几个小版本 |
| API | 以 sing-box `experimental.clash_api` 为核心 |
| 配置 | JSON 配置，后续支持多文件 merge 视图 |

## 15. 里程碑建议

### M1: 可连接

1. 静态 Web 应用框架。
2. 当前控制器设置。
3. API 连接检测。
4. 最小安全提示。

### M2: 可监控

1. 概览看板。
2. 流量展示。
3. 连接列表。
4. 日志查看。

### M3: 可控制

1. 节点列表。
2. selector 切换。
3. 延迟测试。
4. 断开连接。

### M4: 可校验

1. 配置导入。
2. JSON 校验。
3. Clash API 必要配置识别。
4. 诊断信息复制。

## 16. P0 验收清单

| 编号 | 验收项 |
|---|---|
| A1 | 用户可配置一个本机或局域网 sing-box Clash API 控制器 |
| A2 | 鉴权成功和失败能被准确区分 |
| A3 | CORS/PNA 问题能给出明确修复建议 |
| A4 | 可展示版本、模式、流量和连接数 |
| A5 | 可展示 outbounds 和 selector 策略组 |
| A6 | 可切换 selector 当前节点 |
| A7 | 可为不同节点或策略组配置不同测试地址并执行测试 |
| A8 | 可查看连接并断开单个连接 |
| A9 | 可查看日志并按级别或关键词过滤 |
| A10 | 可导入 JSON 配置并输出必要校验结果 |
| A11 | `0.0.0.0` 且空 `secret` 被识别并提示原因，但不强制阻断 |

## 17. 风险与待确认问题

| 风险 | 影响 | 建议 |
|---|---|---|
| 浏览器无法访问私网 API | 公网站点连接本地 sing-box 失败 | 在连接检测中优先识别 CORS/PNA，并提供配置示例 |
| sing-box API 与 Clash Meta 不完全一致 | 面板功能在不同版本表现不同 | 建立 API client 适配层和版本能力探测 |
| 可视化配置字段过多 | P1 范围失控 | JSON 编辑器优先，表单覆盖高频字段 |
| 订阅格式复杂 | 解析错误和兼容成本高 | 建立中间节点模型和失败报告 |
| zashboard 已覆盖大量通用面板能力 | 如果只复刻，产品价值不清晰 | P0 对齐基础体验，差异点放在 sing-box 配置理解、必要诊断和测试地址粒度 |

## 18. 参考资料

1. sing-box 配置结构: https://sing-box.sagernet.org/configuration/
2. sing-box Clash API 配置: https://sing-box.sagernet.org/configuration/experimental/clash-api/
3. sing-box Selector outbound: https://sing-box.sagernet.org/configuration/outbound/selector/
4. sing-box URLTest outbound: https://sing-box.sagernet.org/configuration/outbound/urltest/
5. sing-box Route Rule: https://sing-box.sagernet.org/configuration/route/rule/
6. sing-box DNS Rule: https://sing-box.sagernet.org/configuration/dns/rule/
7. sing-box Rule Set: https://sing-box.sagernet.org/configuration/rule-set/
8. zashboard: https://github.com/Zephyruso/zashboard
