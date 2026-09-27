# Extension packages

nekcode does not install, update, or discover extension packages from settings. Package-management commands and package declarations are intentionally disabled.

Use `-e` or `--extension` to load an extension for one invocation:

```bash
nek -e ./path/to/extension.ts
nek -e ./path/to/extension-directory
```

An extension directory may contain an `index.ts` or `index.js`. It may also expose explicit entry points under the `nek` key in `package.json`:

```json
{
  "name": "my-nek-extension",
  "nek": {
    "extensions": ["./src/extension.ts"]
  }
}
```

Extensions run with the permissions of the `nek` process. Review their source before loading them, especially when they execute shell commands, access files, or make network requests.

For built-in behavior, see [nekcode](nek.md). For extension APIs, see [Extensions](extensions.md). The `extensions`, `packages`, and related package-install settings from upstream configurations are ignored by nekcode.
