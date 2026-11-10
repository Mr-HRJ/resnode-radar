# Cloudflare 部署

网站地址：https://resnode-radar.haorenjie1997.workers.dev/

此部署基于 [ResNode Radar](https://github.com/majiayu000/resnode-radar)，保留原项目 MIT 许可证。

- Cloudflare Workers Static Assets 提供网页。
- 本仓库的 `monitor.yml` 每 30 分钟运行采集器，校验并提交 `data/products.json`，同时覆盖普通 VPS 和家宽 / 住宅产品。
- Worker 的 `/data/products.json` 读取本仓库 `main` 分支的公开数据，边缘缓存 60 秒；无需为库存更新重新部署网页。
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

首次启用 GitHub fork 后，需要启用 `Monitor VPS Sources` 工作流并手动运行一次。此流程只使用 GitHub Actions 自带的仓库令牌，不需要把 Cloudflare 密钥存入 GitHub。

GitHub 的定时任务可能延迟，库存不保证秒级更新；以页面显示的最后采集时间和商家官网为准。网页代码修改后需要再次发布，库存更新无需发布。
