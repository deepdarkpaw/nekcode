# nekcode 用户手册

nekcode 的完整用户手册，用 [VitePress](https://vitepress.dev) 构建，发布在 <https://deepdarkpaw.github.io/nekcode/>。

```bash
cd site
npm ci --ignore-scripts
npm run dev       # 本地预览，http://localhost:5173/nekcode/
npm run build     # 构建到 docs/.vitepress/dist，同时检查站内死链
npm run deploy    # 构建并发布到 gh-pages 分支
```

- 页面在 `docs/` 下，按 `start/`、`guide/`、`platform/`、`customize/`、`develop/`、`reference/` 分组。
- 侧边栏和站点设置在 `docs/.vitepress/config.mts`，新增页面后需要在 `sidebar` 里登记。
- GitHub Pages 的来源是 `gh-pages` 分支的根目录。`npm run deploy`（`scripts/deploy.mjs`）克隆该分支、替换内容、提交并 fast-forward 推送，不会强推。
- `.github/workflows/docs.yml` 在推送到 `nek` 且改动 `site/` 时执行同样的发布。仓库的 Actions 处于关闭状态时它不会运行，请在本地执行 `npm run deploy`。
- 英文的开发者文档仍在 `packages/coding-agent/docs/`。
