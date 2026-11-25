# Cloudflare 部署

> 历史部署文档。当前正式站为 https://vpsld.com/，发布请遵循 [VPS 部署](vps-deployment.md)。GitHub 采集已停用，生产不依赖此 Worker。

网站地址：https://resnode-radar.haorenjie1997.workers.dev/

此部署基于 [ResNode Radar](https://github.com/majiayu000/resnode-radar)，保留原项目 MIT 许可证。

- Cloudflare Workers Static Assets 提供网页。
- **目标采集频率：每 10 分钟触发一次。** Cloudflare Worker 的 Cron Trigger（`*/10 * * * *`，见 `wrangler.json`）调用 GitHub `workflow_dispatch` 运行 `monitor.yml`。GitHub 自带的 `schedule` 只作兜底；`scripts/collection-guard.mjs` 按 UTC 10 分钟时间段去重，同一时间段已经开始并发布的采集会跳过。这样延迟的兜底运行不会因为“快照不足 7 分钟”压掉下一次正常触发。工作流串行执行，避免并发发布。
- **必须配置的密钥**：`npx wrangler secret put GITHUB_DISPATCH_TOKEN`，值为 Fine-grained PAT（仅授权本仓库，Repository permissions → Actions: Read and write）。密钥缺失、权限不足、GitHub 非 204 响应和网络失败都会让 Cron 调用失败，不能把“触发失败”记录成成功。
- **数据发布**：工作流校验通过后，把 `data/products.json` 与 `data/fx.json` 作为一个孤立提交强制推送到 `data` 分支，避免给 `main` 累积快照历史。旧对象何时被 GitHub 回收不受此工作流控制，不能保证远端存储大小不增长。恢复历史快照遇到网络/权限错误时终止发布；仅分支确实不存在时允许使用 `main` 的初始基线。Worker 读取 `DATA_BRANCH`（默认 `data`），边缘缓存 60 秒，上游还可能存在缓存。
- 本地或独立节点可通过 `npm start`（即 `scripts/monitor-daemon.mjs --serve --port 4173 --interval 10`）或 macOS 系统级守护服务 `npm run service:install` 按 10 分钟固定节拍巡检。
- 单次采集按来源域名分为并行“通道”（`MONITOR_CONCURRENCY`，默认 12；同一来源仍按 `requestIntervalMs` 限速）。每个源的 `MONITOR_SOURCE_BUDGET_MS`（默认 150 秒）会取消进行中的 HTTP、限速等待、重试等待和浏览器探测；超时保留已读套餐并显示诊断。同一通道有多个源，单源预算不等于整轮预算，仍须实测整轮耗时。
- `fx:update` 在定时采集前更新欧洲央行参考汇率；采集器将经过校验的汇率和库存变化记录一并写入 `data/products.json`。更新失败时保留汇率原始日期。
- 数据源不可用时接口返回 503，页面显示库存未知。采集失败和被阻断的商家仍使用原项目的状态标记。

## 发布

安装已有依赖并验证：

```sh
npm ci
npm test
npm run check
npm run monitor:validate
npm run build:cloudflare
npx --yes wrangler@4.160.0 deploy --dry-run
```

使用已登录的 Cloudflare 账户发布：

```sh
npm run deploy:cloudflare
```

`wrangler.json` 中的 `SITE_URL` 决定规范网址和站点地图；`DATA_REPOSITORY` 指向当前维护者自己的公开仓库。部署包仅包含网页资产和许可证，不发布采集程序、Git 目录或本地库存快照。

### 上线顺序（10 分钟采集）

1. 推送代码到 `main`。
2. 在 GitHub Actions 中手动运行一次 `Monitor VPS Sources`（勾选 `force`），确认生成了 `data` 分支：`gh workflow run monitor.yml -R Mr-HRJ/resnode-radar -f force=true`。
3. 配置 Worker 密钥：`npx --yes wrangler@4.160.0 secret put GITHUB_DISPATCH_TOKEN`。
4. `npm run deploy:cloudflare` 发布 Worker（包含新的 Cron 与 `DATA_BRANCH`）。必须在第 2 步之后发布，否则 `data` 分支尚不存在，接口会返回 503。
5. 验证：连续检查至少三个时间段的 Cron 结果、`gh run list -R Mr-HRJ/resnode-radar --workflow monitor.yml` 中的 `workflow_dispatch` 运行、`data` 分支快照时间与网页显示时间。204 只证明触发已接受，不能证明采集或发布完成。

此流程中 GitHub 侧只使用 Actions 自带的仓库令牌；Cloudflare 侧只保存一个仅能触发本仓库 Actions 的 PAT。

GitHub Actions 的排队、运行时间、上游缓存以及网页每五分钟刷新均会增加可见延迟；这套方案提供每 10 分钟触发的目标，不是严格的 10 分钟完成保证。若需要严格周期，应在常驻节点运行采集器并独立发布数据。以页面显示的最后采集时间和商家官网为准。网页代码修改后需要再次发布，库存更新无需发布。
