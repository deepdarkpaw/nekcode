# 本地模型（llama.cpp）

nek 内置对 [llama.cpp](https://github.com/ggml-org/llama.cpp) **路由服务（router）**的支持。路由服务能发现一个目录下的多个 GGUF 模型，并按需加载和卸载。

其他本地服务（Ollama、LM Studio、vLLM、SGLang 等）按 [兼容接口](/guide/models#compatible-endpoint) 写进 `models.json` 即可。

## 启动路由服务

使用支持 router 模式的较新 llama.cpp。可以按 [官方构建说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) 编译，或下载对应平台的 [预编译版本](https://github.com/ggml-org/llama.cpp/releases)。

启动 `llama-server` 时**不要**传 `--model`、`-m` 或 `-hf`，否则会进入单模型模式：

```bash
llama-server \
  --models-dir ~/models \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

| 参数 | 作用 |
|---|---|
| `--models-dir ~/models` | 扫描这个目录下的 GGUF 文件 |
| `--jinja` | 启用兼容的对话模板和工具调用 |
| `-ngl 999` | 尽可能多地把层放到 GPU 上 |
| `-c 32768` | 每个加载的模型的上下文长度。省略时使用模型原生长度，可能需要多得多的显存/内存 |
| `--host 127.0.0.1` | 只允许本机访问 |
| `--no-models-autoload` | 可选。关闭“选中即加载”，模型需要你在路由服务上手动加载 |

单文件模型可以直接放在模型目录下；多模态模型和分片模型放在各自的子目录里：

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

手动添加文件后需要重启路由服务。每个模型单独的上下文长度等选项用 llama.cpp 的 [model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets) 配置。

## 在 nek 中连接

在 nek 里运行：

```text
/login llama.cpp
```

输入路由服务地址（默认 `http://127.0.0.1:8080`）和可选的 API key。然后用 `/model` 选择模型。

也可以用环境变量配置，不经过 `/login`：

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
nek
```

如果路由服务设置了 API key，启动 `llama-server` 时用相同的 `--api-key`。

## 选择和加载模型

- 已加载和休眠中的模型会出现在 `/model` 里，休眠的模型被选中时自动唤醒。
- 开启自动加载（默认）时，未加载的预设模型也会出现，选中时加载。
- 使用了 `--no-models-autoload` 时，`/model` 只列出已加载的模型，需要先在路由服务上加载模型（例如通过 llama.cpp 自带的 Web 界面或它的 HTTP 接口）。

路由服务可能同时被其他客户端使用，nek 显示的始终是路由服务当前的状态。

## 排查问题

先确认路由服务能访问：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

| 现象 | 处理 |
|---|---|
| 路由服务里没有模型 | 检查 `--models-dir` 和目录结构，然后重启路由服务 |
| 用了 `--no-models-autoload`，`/model` 里看不到模型 | 先在路由服务上加载模型 |
| 加载失败或内存占用过高 | 调小 `-c`，或卸载其他模型 |
| 不是 router 模式 | 去掉 `--model`、`-m`、`-hf` 后重新启动 |
