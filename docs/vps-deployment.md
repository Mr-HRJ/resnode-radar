# VPS 部署

目标域名：`https://vps.bnoai.com/`。网站与采集都运行在 VPS，运行期间不依赖 GitHub Actions、Cloudflare Worker 或调度令牌。

**当前状态（2026-11-22）：下述上线验收完成后，服务器开始清盘重装 Ubuntu。原 VPS 网站和采集服务已中断，尚未恢复。以下记录是重装前的验收结果，不代表当前服务在线。遵循全新安装的要求，本任务已停止服务器写入和自动恢复。** 本地项目、发布包和公开数据快照仍保留；域名仍指向原服务器 IP，GitHub 采集仍处于停用状态。

## 文件布局

- `/opt/resnode-radar/releases/<release>/`：完整项目与生产依赖，由管理员维护。
- `/opt/resnode-radar/current`：指向当前发布版本。
- `/var/lib/resnode-radar/data/`：持久化快照、汇率和守护进程状态，由 `resnode-radar` 服务用户写入。
- 每个版本的 `data` 目录链接到持久化数据目录；升级或回滚代码时保留采集状态。

构建使用 `npm run build:vps`，可用 `SITE_URL=https://example.com/` 指定其他域名。`dist` 只包含浏览器资产；数据不打包到静态目录。

## 部署与切换

目标系统为 Debian 13，复用已有 Nginx 和 Certbot。Node.js 24 安装在项目专用目录 `/opt/resnode-radar/node`，不替换其他项目的运行时。`deploy/vps/nginx.conf` 是申请证书前的 HTTP 站点配置，安装到独立的 `sites-available/resnode-radar`，不覆盖其他站点。域名须解析到 VPS，80/443 端口须可达。

创建服务用户和持久化数据目录，导入经过校验的最新 `products.json` 与 `fx.json`，设置版本的 `data` 链接。安装依赖并运行测试、语法检查、数据校验和 VPS 构建后，切换 `current` 链接。

为 `/var/lib/resnode-radar/acme` 配置 Webroot 验证，申请 `vps.bnoai.com` 的独立证书，再用 `deploy/vps/nginx-https.conf` 替换本项目的 HTTP 站点配置以启用 HTTPS 和 HTTP 跳转；启用 Certbot 自动续期及续期后的 Nginx reload。

安装并启用 `deploy/vps/resnode-radar.service`。守护进程使用 10 分钟节拍、不重叠执行、失败退避重试；采集结果通过校验后原子替换。Web 服务器只公开构建目录和 `/data/products.json`，不公开项目源码目录、配置或守护进程状态。

```sh
systemctl enable --now resnode-radar
systemctl status resnode-radar
journalctl -u resnode-radar --since '30 minutes ago' --no-pager
```

访问日志使用 Nginx 的 logrotate 策略；采集日志由 journald 管理，部署时检查宿主的保留策略。服务重启测试后，观察至少两个完整采集周期，验证域名 HTTPS、快照更新时间、来源覆盖与真实失败信息。完成验证后，再停用 GitHub 定时采集；保留旧站点直到新站验收完成。

## 重装前的上线验收

2026-11-22 曾上线至 `https://vps.bnoai.com/`，DNS 指向 `62.83.135.52`。当时版本目录为 `/opt/resnode-radar/releases/20261122T163908Z`，使用 Node.js 24.22.3。

- 本地和 VPS 均通过 261 项测试；公开的 35 个静态文件与构建产物一致。
- 两轮真实采集均通过 161 个源的覆盖校验，分别耗时约 239 秒和 231 秒。快照时间为 `16:41:37.110Z`、`16:51:37.335Z`，间隔 600.225 秒；公网数据接口已读取到第二轮结果。
- 第二轮共有 3145 条记录，其中 26 条标记为受阻、1 条为错误。这些源的访问限制仍如实保留，不代表迁移失败。
- 服务重启后保留数据并恢复原定节拍；`resnode-radar`、Nginx 和 Certbot 续期定时器均已启用。证书自动续期演练及续期后的 Nginx 配置检查、reload 通过。
- HTTP 自动跳转 HTTPS；源码、`.git`、`.env`、内部状态和采集配置的公开路径均返回 404。
- GitHub 的 `monitor.yml` 已停用，CI 保留。旧 Cloudflare 站点保留作为迁移前版本；生产入口改为 VPS 域名，不再需要 `GITHUB_DISPATCH_TOKEN`。

后续发布需先验证新版本，再切换 `current` 链接并重启本项目服务。不要覆盖 `/var/lib/resnode-radar/data`，不要修改同机其他站点的 Nginx 配置或证书。若要恢复 GitHub 采集，可手动启用 `monitor.yml`，并先确认不会与 VPS 重复运行。

本地 `logs/resnode-20261122T163908Z.tar.gz` 保存已部署的项目发布包，`logs/vps-release.json` 保存文件校验清单；`logs/vps-second-snapshot.json` 和 `logs/vps-cadence-verification.json` 保存第二轮公开快照及 600.225 秒节拍验证。它们不包含服务器证书私钥或 SSH 私钥，不能视为完整系统备份。
