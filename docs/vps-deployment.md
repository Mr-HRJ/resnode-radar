# VPS 部署

2026-11-22 已在 Ubuntu 24.04.5 LTS 上恢复完整项目。网站、采集程序与数据运行在 `62.83.135.52`；当前版本为 `/opt/resnode-radar/releases/20261122T171023Z`，Node.js 为 24.22.3。

- 正式入口：`https://vps.bnoai.com/`，按用户同日最新要求使用源站直连，Cloudflare 只提供 DNS。
- 备用入口：`https://vps-direct.bnoai.com/`，同一应用与数据，同样直连源站。
- 采集周期：**20 分钟**，以每轮启动时间为基准，不重叠执行；失败退避重试，成功校验后原子替换数据。
- GitHub 的 `monitor.yml` 已停用，CI 保留。生产采集不依赖 GitHub Actions、Cloudflare Worker 或 `GITHUB_DISPATCH_TOKEN`。

## 文件与服务

- `/opt/resnode-radar/releases/<release>/`：完整代码与生产依赖，由管理员维护。
- `/opt/resnode-radar/current`：当前发布版本链接。
- `/opt/resnode-radar/node`：本项目使用的 Node.js，不替换同机其他应用的运行时。
- `/var/lib/resnode-radar/data/`：持久化 `products.json`、汇率及守护进程状态，由 `resnode-radar` 用户写入。每个发布版本的 `data` 链接到这里。
- `/var/lib/resnode-radar/static/<revision>/`：按内容生成版本号的浏览器资源，由发布操作写入，跨版本保留。
- `/etc/systemd/system/resnode-radar.service`：开机启动、退出自动重启，显式传入 `--interval 20`，禁止 Git 自动发布。
- `/etc/nginx/sites-available/resnode-radar`：独立的 Nginx 站点配置，仅公开构建目录、版本化静态资源和库存 JSON。

```sh
systemctl status resnode-radar
journalctl -u resnode-radar --since '45 minutes ago' --no-pager
cat /var/lib/resnode-radar/data/daemon-status.json
```

## 缓存与网络

当前使用 DNS-only，访问不经过 Cloudflare 边缘缓存。源站压缩、HTTP/2 和版本化资源的浏览器缓存继续生效。以下边缘策略已配置并验证，保留以便后续明确需要时重新启用代理；不能把先前的 CF 命中测试当作当前访问路径。

| 内容 | 浏览器缓存 | Cloudflare 边缘缓存 |
| --- | --- | --- |
| `/static/<内容版本>/...` 的 JS、CSS、图片 | 1 年，immutable | 1 年 |
| HTML、`/data/products.json`、其余公开文件 | 立即重新验证 | 60 秒 |
| ACME 验证路径、无缓存头的错误响应 | 不纳入本规则 | 不缓存 |

`build:vps` 把浏览器资源复制到内容版本目录，重写 HTML 的资源地址，并保留模块内部的相对引用。发布时保留旧版本资源，避免尚未过期的 HTML 引用不存在的 JS/CSS。前端请求稳定的库存 URL，取消随机时间戳，以共享边缘缓存；页面仍每 5 分钟重新读取已发布的数据，手动重载不会触发后端采集。

Cloudflare 规则 `VPS Radar public cache — origin TTL`（`4998758453244597875b4e7a8d8e9a33`）仅匹配：

```text
(http.host eq "vps.bnoai.com" and http.request.method in {"GET" "HEAD"} and not starts_with(http.request.uri.path, "/.well-known/"))
```

设置为符合缓存条件、使用源站缓存头（缺失则绕过）、浏览器接受源站 TTL、更新时不返回过期内容。源站通过 `Cloudflare-CDN-Cache-Control` 指定 60 秒边缘寿命；没有使用免费套餐界面的长时间强制 TTL。Nginx 已启用 gzip 与 HTTP/2，Cloudflare 公网响应同时提供 HTTP/3。

国内测速表明，缓存命中不等于跨境线路一定更快：本次北京云服务器节点能访问 CF，但武汉、福州联通测点出现 CF 超时/连接重置；相同测点的源站直连请求成功。最初为此提供独立的直连备用域名；用户随后要求各项目主站统一改为直连。测试没有覆盖北京联通家庭宽带，不能将其他城市/运营商结果当成其速度保证。原始结果保留在本地 `logs/globalping-*-results.json`。

## HTTPS 与发布

证书同时覆盖两个域名，使用 `/etc/letsencrypt/live/vps.bnoai.com/`。Certbot 定时器已启用，`deploy/vps/renew-certificate.sh` 在续期后检查并重新加载 Nginx。HTTP 分别跳转到本域名的 HTTPS。HTTP 与 HTTPS 均提供 ACME Webroot 验证路径，兼容 Cloudflare 的 HTTPS 重定向；加入直连域名后的双域名续期演练已通过。

首次部署可先用 `deploy/vps/nginx.conf` 完成正式域名的 Webroot 验证，再安装 `deploy/vps/nginx-https.conf`，添加直连域名并扩展证书。所有操作只改本项目的文件和服务。

后续发布：

1. 在新版本目录安装依赖，运行 `npm test`、`npm run check`、`npm run monitor:validate` 和 `npm run build:vps`。
2. 将新版本 `data` 链接到持久化目录，将 `dist/static/` 中的新内容版本复制到 `/var/lib/resnode-radar/static/`；保留旧版本。
3. 在上一轮采集结束后切换 `current`，重启本项目服务。新旧版本都使用同一个持久化数据目录。
4. 配置有变化时先运行 `nginx -t`，再 reload。验证两个域名、浏览器缓存头和最新数据。DNS-only 无边缘缓存；将来启用代理时 HTML 最多缓存 60 秒，无需清空整个 Cloudflare 区域。

不要覆盖持久化数据，不要修改同机其他站点的配置、证书或代理服务。采集日志由 journald 管理，访问日志沿用 Nginx 的 logrotate 策略。

## 家宽备用采集出口

启用后，绿云和 NovixLink 先从 VPS 直连，只有连接错误或公开页面的 403/验证页才重试家宽出口；单独的登录要求与 429 限流不会触发切换。其他商家继续直连。两次尝试各受原有的源级时间预算、请求间隔和官方域名校验约束；整体仍由 `resnode-radar` 每 20 分钟执行且不重叠。家宽结果在 `raw.egress` 标记为 `residential`，失败时保留诊断与直连已采到的商品，不把失败当成缺货。

VPS 独立运行 Mihomo v1.19.33，无需本地电脑在线。部署该版本时核验官方 Linux amd64-v1 压缩包 SHA-256：`8ec92e7b2fdc6b853ba00156bab7e4e965c8b0d843b8c4ac8ab98795f02ad524`。二进制放在 `/opt/resnode-radar-egress/mihomo`。

- `deploy/vps/resnode-radar-egress.service` 安装为同名 systemd 服务；使用动态用户、受限文件系统和 `LoadCredential`，开机自启。
- 节点配置仅存 `/etc/resnode-radar-egress/config.yaml`，目录权限 0700、文件权限 0600，归 root 所有；不能放进仓库、公开目录或采集 JSON。
- 家宽节点侧的来源 IP 白名单必须包含采集 VPS `62.83.135.52`。只有本机或中转机在名单里时，本机测试成功也不能证明 VPS 能连通；保存白名单后须等待供应商防火墙同步再验证。
- 配置监听 `127.0.0.1:17897`，关闭 LAN、TUN、DNS 服务和外部控制接口。规则仅允许 `greencloudvps.com`、`green.cloud`、`novixlink.com` 及子域走家宽，最后 `MATCH,REJECT`。
- 先验证 VPS 能独立连接节点、两个目录能通过代理采集，再将 `deploy/vps/residential-fallback.conf` 安装到 `/etc/systemd/system/resnode-radar.service.d/residential-fallback.conf`，执行 `systemctl daemon-reload`，在采集空闲时重启主服务。连通验证失败时保留配置但不启用 drop-in，继续原有直连采集。
- 备用服务故障不阻止主服务启动；停用备用功能可移除该 drop-in 后 reload/restart 主服务。不要设置全局 `HTTP_PROXY` 或修改服务器默认路由。

HTTP/1.1 与 HTTP/2 都通过 CONNECT 隧道连接，仍验证上游 HTTPS 证书。验收需检查两个服务、回环监听端口、实际出口 IP，以及完整新快照中只有上述两家出现 `raw.egress=residential`。

## 验收证据

本地和 Ubuntu 的全量测试各 262 项通过；20 分钟配置变更后的本地全量测试、服务器守护进程测试也通过。GitHub CI `45049224892` 成功。服务重启后保留已有快照，下一轮按新间隔恢复。

64 个公开文件均已核验：63 个与发布包哈希一致，`robots.txt` 被 Cloudflare 加入既有的 Managed Content 前缀，原始站点地图内容保留。源码、`.git`、`.env`、内部状态与采集配置路径均返回 404。

切换直连前，HTML、库存 JSON 和版本化 JS 均实测 `CF-Cache-Status: HIT`，库存压缩传输约 586 KB。首次 Ubuntu 采集覆盖 161 个源，耗时约 232 秒，3145 条记录；其中 26 条受阻诊断和 1 条 VMVM 域名解析错误仍如实保留。

两轮真实快照时间为 `2026-11-22T17:13:33.909Z` 与 `2026-11-22T17:33:34.373Z`，间隔 1200.464 秒。第二轮由守护进程自动启动，耗时 221.476 秒，完成后约 3 秒已从 Cloudflare 取得新快照；161 个源校验通过，下一次启动计划为 `17:53:33.960Z`。主站和直连站的最新数据哈希一致。

本地 `logs/ubuntu-release.json`、`logs/ubuntu-assets-verification.json`、`logs/ubuntu-cache-verification.json` 保存发布及验证记录；定时更新结果见 `logs/ubuntu-cadence-verification.json`，最终页面截图为 `logs/ubuntu-live.jpg`。已部署版本及本轮数据的恢复包为 `logs/resnode-ubuntu-verified-20261122.tar.gz`，依赖可通过锁文件重新安装。恢复包不包含证书私钥、SSH 私钥、Node.js 运行时或完整系统配置，不能视为完整系统备份。
