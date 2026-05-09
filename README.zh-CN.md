# SingDeck

[English](README.md) | [简体中文](README.zh-CN.md)

SingDeck 是一个本地优先、单 sing-box 控制器的 Web 面板。前端会从浏览器直接访问一个 `experimental.clash_api` endpoint。可选的本地 helper 服务提供节点评分、定时探测、配置文件读取、原始配置下载和订阅流量快照等能力。

## 功能

- 单 sing-box Clash API 控制器配置，支持类似 zashboard 的 URL 参数初始化。
- 连接检测，并对鉴权、网络、CORS、Private Network Access 等失败给出提示。
- 运行时面板，展示版本、模式、上下行速率、总流量和连接数。
- 代理拓扑、selector 切换、单节点延迟测试和策略组测试 URL 覆盖。
- 可选 helper 服务，支持策略组评分、定时探测、自动切换和配置文件访问。
- 连接浏览、过滤和关闭连接。
- 日志工作区，支持等级和文本过滤。
- JSON 配置工作区，提供必要的 sing-box 面板配置检查、快照、导入/导出内容和敏感字段脱敏。
- 前端解析常见 `ss://`、`trojan://`、`vless://` 订阅链接。
- 高级工具：路由模拟、selector 图边、Linux 粘贴输出诊断和 API 兼容处理。

## 架构

SingDeck 有两种运行方式：

- 纯前端模式：把构建后的 `dist/` 目录作为静态站点部署。浏览器直接连接 sing-box Clash API。
- 前端加 helper 模式：部署静态前端，并在 sing-box 附近运行 `singdeck-helper`。helper 使用 SQLite 保存本地状态，并从所在主机访问 Clash API。

基础运行时控制不需要后端。helper 是可选的，但如果要使用 helper 评分、定时探测、自动切换、直接读取配置文件、原始配置下载和流量工作区，就需要启动 helper。

## 前置条件

- 前端需要 Node.js 和 pnpm。
- helper 需要 Rust 和 Cargo。
- 已运行的 sing-box，并启用 `experimental.clash_api`。
- 可访问的 Clash API 地址，例如 `http://127.0.0.1:9090`。

## sing-box 配置

在 sing-box 配置中启用 Clash API：

```jsonc
{
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "secret": "change-this-secret"
    }
  }
}
```

只要 controller 可能被本机以外的设备访问，就应该配置 `secret`。如果前端运行在另一台机器或手机上，controller 必须能被那个浏览器访问，而不仅仅是能被部署 SingDeck 的服务器访问。

## 开发运行

安装依赖并启动 Vite 开发服务：

```bash
pnpm install
pnpm start
```

`pnpm start` 会以 `--host 0.0.0.0` 启动 Vite，只适合开发和本地测试，不是生产部署方式。

如果需要 helper 能力，在另一个终端启动 helper：

```bash
SINGDECK_HELPER_BIND=127.0.0.1:9531 \
SINGDECK_HELPER_DB=$HOME/.local/state/singdeck/helper.db \
pnpm helper:dev
```

打开前端后进入 Settings：

1. 设置 controller URL，例如 `http://127.0.0.1:9090`。
2. 填写 sing-box 中相同的 `secret`。
3. 设置 helper URL，例如 `http://127.0.0.1:9531`。
4. 同步或检查 helper。
5. 如需读取配置文件，设置配置路径，例如 `/etc/sing-box/config.json` 或 `/etc/sing-box/config.jsonc`。

## 前端部署

构建静态应用：

```bash
pnpm install
pnpm build
```

生产文件会输出到 `dist/`。可以用任意静态站点服务托管该目录，例如 nginx、Caddy、对象存储、Pages 或 CDN。

nginx 示例：

```nginx
server {
  listen 80;
  server_name singdeck.example.com;

  root /var/www/singdeck/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

Vite 配置使用了 `base: './'`，所以应用也可以部署在子目录下。

本地预览生产构建：

```bash
pnpm preview
```

## helper 部署

构建 helper 二进制：

```bash
cargo build --release --manifest-path helper/Cargo.toml
```

创建状态目录并运行二进制：

```bash
sudo mkdir -p /var/lib/singdeck
sudo chown "$USER":"$USER" /var/lib/singdeck

SINGDECK_HELPER_BIND=127.0.0.1:9531 \
SINGDECK_HELPER_DB=/var/lib/singdeck/helper.db \
./helper/target/release/singdeck-helper
```

helper 代码默认监听 `0.0.0.0:9531`，因此除非你明确需要局域网访问，否则建议显式设置 `SINGDECK_HELPER_BIND`。helper 没有内置鉴权，并且 CORS 是放开的。

仓库在 `deploy/systemd` 下提供了 systemd 模板：

- `singdeck-helper.service`：helper 独立服务。
- `singdeck-helper.with-sing-box.service`：跟随 `sing-box.service` 启动、停止和重启。
- `singdeck-helper.env.example`：helper 共用环境变量文件。

安装 helper 二进制和环境变量文件：

```bash
id -u singdeck >/dev/null 2>&1 || sudo useradd --system --home /var/lib/singdeck --shell /usr/sbin/nologin singdeck
sudo install -Dm755 helper/target/release/singdeck-helper /opt/singdeck/singdeck-helper
sudo install -Dm640 deploy/systemd/singdeck-helper.env.example /etc/singdeck/helper.env
```

独立启动方式：

```bash
sudo install -Dm644 deploy/systemd/singdeck-helper.service /etc/systemd/system/singdeck-helper.service
sudo systemctl daemon-reload
sudo systemctl enable --now singdeck-helper.service
```

跟随 sing-box 同步启动方式：

```bash
sudo install -Dm644 deploy/systemd/singdeck-helper.with-sing-box.service /etc/systemd/system/singdeck-helper.service
sudo systemctl daemon-reload
sudo systemctl enable singdeck-helper.service
sudo systemctl restart sing-box.service
```

同步 unit 使用了 `BindsTo=sing-box.service`、`PartOf=sing-box.service`、`After=sing-box.service` 和 `WantedBy=sing-box.service`。启动 `sing-box.service` 时会同时启动 helper；停止或重启 sing-box 时也会同步影响 helper。如果你的 sing-box unit 名称不同，请先修改模板再安装。

## helper 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SINGDECK_HELPER_BIND` | `0.0.0.0:9531` | helper HTTP API 的监听地址和端口。本机访问建议设为 `127.0.0.1:9531`。 |
| `SINGDECK_HELPER_DB` | `singdeck-helper.db` | SQLite 状态数据库路径。部署环境建议放在 git 工作区之外。 |
| `SINGDECK_HELPER_PUBLIC_URL` | 未设置 | 用来生成 `/api/v1/config/raw` 远程配置导入链接的公开 base URL。 |
| `SINGDECK_BROWSER_PROFILE` | `~/.config/google-chrome/Default` | 流量工作区读取 provider cookie/localStorage 时使用的 Linux Chrome profile。 |

helper 数据库会保存 controller 设置、secret、策略组设置、定时探测时间戳和探测样本。不要提交它，也不要把它作为部署产物分享。

## 校验

运行前端测试和生产构建：

```bash
pnpm check
```

运行 helper 测试：

```bash
pnpm helper:test
```

检查运行中的 helper：

```bash
curl http://127.0.0.1:9531/api/v1/health
```

响应中应包含 `ok`、`sqlite`、`controllerConfigured`、`controllerReachable` 等字段。

## 安全注意事项

- 前端会把 controller 设置保存在当前浏览器中。
- URL 参数中的 `secret` 可能进入浏览器历史、书签、截图或分享链接，建议在 Settings 中填写。
- 不要在没有 `secret` 的情况下把 sing-box Clash API 暴露到 `0.0.0.0`。
- 不要把 helper 暴露到公网。helper 没有鉴权，并且可以读取已配置的本地文件。
- 浏览器到 controller 的请求可能被 CORS、HTTPS 到 HTTP 的 mixed content 限制或 Private Network Access 限制阻止。如果 SingDeck 部署在公网 HTTPS origin，而 controller 是私有 HTTP 地址，请在目标浏览器上实际测试。
- 如果手机等设备需要通过 helper 导入原始配置，可以把 helper 绑定到可访问的局域网地址并设置 `SINGDECK_HELPER_PUBLIC_URL`，但要谨慎保护这条网络路径。

## 故障排查

- Helper URL 失败：确认 helper 正在运行，并且在同一台浏览器所在机器上可以执行 `curl http://127.0.0.1:9531/api/v1/health`。
- Controller 已配置但不可达：确认前端纯浏览器功能能从浏览器访问该 URL，helper 功能能从 helper 所在主机访问该 URL。
- 配置工作区无法读取文件：在 Settings 中设置配置路径，并确认 helper 进程用户有读取权限。
- 没有评分结果：先把 controller 同步到 helper，然后加载策略组或手动探测某个策略组。
- 流量工作区显示 provider 错误：检查 `SINGDECK_BROWSER_PROFILE`，并确认相关 provider 的登录 session 存在于该 Chrome profile。
