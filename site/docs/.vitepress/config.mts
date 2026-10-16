import { defineConfig } from "vitepress";

/** GitHub repository that hosts the source and the Pages site. */
const REPO = "https://github.com/deepdarkpaw/nekcode";

/** Sidebar shared by every page, grouped like pi.dev/docs: start, guides, customization, development, reference. */
const sidebar = [
	{
		text: "开始",
		items: [
			{ text: "nekcode 是什么", link: "/start/introduction" },
			{ text: "安装、更新与卸载", link: "/start/install" },
			{ text: "快速上手", link: "/start/quickstart" },
			{ text: "nekcode 如何工作", link: "/start/how-it-works" },
		],
	},
	{
		text: "日常使用",
		items: [
			{ text: "终端界面与输入", link: "/guide/usage" },
			{ text: "选择模型", link: "/guide/models" },
			{ text: "会话与上下文", link: "/guide/sessions" },
			{ text: "内置工具", link: "/guide/tools" },
			{ text: "Plan 模式", link: "/guide/plan-mode" },
			{ text: "Todo 列表", link: "/guide/todos" },
			{ text: "子代理", link: "/guide/subagents" },
			{ text: "MCP 服务器", link: "/guide/mcp" },
			{ text: "本地模型（llama.cpp）", link: "/guide/local-models" },
			{ text: "OpenTUI 界面（实验）", link: "/guide/opentui" },
		],
	},
	{
		text: "安全与隔离",
		items: [
			{ text: "安全使用", link: "/guide/security" },
			{ text: "在隔离环境中运行", link: "/guide/containerization" },
		],
	},
	{
		text: "平台与终端",
		items: [
			{ text: "终端设置", link: "/platform/terminal-setup" },
			{ text: "Shell 命令配置", link: "/platform/shell" },
			{ text: "在 tmux 中运行", link: "/platform/tmux" },
			{ text: "在 Windows 上运行", link: "/platform/windows" },
			{ text: "在 Android（Termux）上运行", link: "/platform/termux" },
		],
	},
	{
		text: "自定义",
		items: [
			{ text: "配置总览", link: "/customize/configuration" },
			{ text: "项目指令（AGENTS.md）", link: "/customize/context-files" },
			{ text: "提示词模板", link: "/customize/prompt-templates" },
			{ text: "Skills", link: "/customize/skills" },
			{ text: "主题", link: "/customize/themes" },
			{ text: "加载扩展", link: "/customize/loading-extensions" },
		],
	},
	{
		text: "扩展开发",
		items: [
			{ text: "编写扩展", link: "/develop/extensions" },
			{ text: "自定义服务商", link: "/develop/custom-provider" },
			{ text: "终端 UI 组件", link: "/develop/tui" },
			{ text: "脚本与程序集成", link: "/develop/cli-integration" },
			{ text: "TypeScript SDK", link: "/develop/sdk" },
		],
	},
	{
		text: "参考",
		items: [
			{ text: "命令行", link: "/reference/cli" },
			{ text: "斜杠命令", link: "/reference/slash-commands" },
			{ text: "快捷键", link: "/reference/keybindings" },
			{ text: "settings.json", link: "/reference/settings" },
			{ text: "nek.yaml", link: "/reference/nek-yaml" },
			{ text: "环境变量", link: "/reference/environment-variables" },
			{ text: "服务商认证", link: "/reference/providers" },
			{ text: "上下文压缩", link: "/reference/compaction" },
			{ text: "Durable 会话与崩溃续跑", link: "/reference/durable-sessions" },
			{ text: "会话文件格式", link: "/reference/session-format" },
			{ text: "消息类型", link: "/reference/message-types" },
			{ text: "JSON 事件流", link: "/reference/json" },
			{ text: "RPC 协议", link: "/reference/rpc" },
			{ text: "RPC 命令", link: "/reference/rpc-commands" },
			{ text: "RPC 扩展 UI", link: "/reference/rpc-extension-ui" },
		],
	},
	{
		text: "帮助",
		items: [{ text: "常见问题与排错", link: "/faq" }],
	},
];

export default defineConfig({
	lang: "zh-CN",
	title: "nekcode",
	description: "nekcode（nek）用户手册：运行在终端里的编程助手",
	base: "/nekcode/",
	cleanUrls: true,
	head: [["link", { rel: "icon", type: "image/svg+xml", href: "/nekcode/logo.svg" }]],
	markdown: {
		lineNumbers: false,
	},
	themeConfig: {
		logo: "/logo.svg",
		siteTitle: "nekcode",
		nav: [
			{ text: "快速上手", link: "/start/quickstart" },
			{ text: "使用指南", link: "/guide/usage" },
			{ text: "参考", link: "/reference/cli" },
			{ text: "GitHub", link: REPO },
		],
		sidebar,
		outline: { level: [2, 3], label: "本页内容" },
		search: {
			provider: "local",
			options: {
				translations: {
					button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
					modal: {
						noResultsText: "没有找到结果",
						resetButtonTitle: "清除查询",
						footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
					},
				},
			},
		},
		editLink: {
			pattern: `${REPO}/edit/nek/site/docs/:path`,
			text: "在 GitHub 上编辑此页",
		},
		socialLinks: [{ icon: "github", link: REPO }],
		docFooter: { prev: "上一页", next: "下一页" },
		darkModeSwitchLabel: "外观",
		sidebarMenuLabel: "目录",
		returnToTopLabel: "回到顶部",
		langMenuLabel: "语言",
		footer: {
			message: "基于 MIT 许可发布。nekcode 基于 pi 二次开发。",
			copyright: "deepdarkpaw/nekcode",
		},
	},
});
