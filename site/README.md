# nekcode 用户手册

nekcode 的完整用户手册，用 [VitePress](https://vitepress.dev) 构建，发布在 <https://deepdarkpaw.github.io/nekcode/>。

```bash
cd site
npm ci --ignore-scripts
npm run dev       # 本地预览，http://localhost:5173/nekcode/
npm run build     # 构建到 docs/.vitepress/dist
```

- 页面在 `docs/` 下，按 `start/`、`guide/`、`platform/`、`customize/`、`develop/`、`reference/` 分组。
- 侧边栏和站点设置在 `docs/.vitepress/config.mts`，新增页面后需要在 `sidebar` 里登记。
- 推送到 `nek` 分支且改动涉及 `site/` 时，`.github/workflows/docs.yml` 自动构建并部署到 GitHub Pages。构建会检查站内死链。
- 英文的开发者文档仍在 `packages/coding-agent/docs/`。
