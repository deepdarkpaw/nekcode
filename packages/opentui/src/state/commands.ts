/**
 * Routing of submitted input. Slash commands of the built-in TUI that have an RPC equivalent run
 * through it; TUI-only commands get a short notice; everything else (including extension, prompt,
 * and skill commands) passes through to the backend as a prompt.
 */

export type InputAction =
	| { kind: "prompt"; text: string }
	| {
			kind: "rpc";
			command:
				| "new_session"
				| "compact"
				| "set_session_name"
				| "set_thinking_level"
				| "set_model"
				| "export_html"
				| "clone"
				| "get_session_stats";
			arg?: string;
	  }
	| { kind: "quit" }
	| { kind: "help" }
	| { kind: "unsupported"; name: string }
	| { kind: "usage"; text: string };

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Built-in TUI commands that the OpenTUI frontend does not provide. */
export const UNSUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
	"settings",
	"tree",
	"scoped-models",
	"import",
	"share",
	"copy",
	"changelog",
	"fork",
	"trust",
	"login",
	"logout",
	"resume",
	"reload",
]);

/** Classify one submitted input. Returns undefined for blank input. */
export function routeInput(input: string): InputAction | undefined {
	const text = input.trim();
	if (text === "") return undefined;
	const match = /^\/([a-z][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i.exec(text);
	if (!match) return { kind: "prompt", text: input };
	const name = match[1].toLowerCase();
	const arg = match[2]?.trim() || undefined;
	switch (name) {
		case "quit":
		case "exit":
			return { kind: "quit" };
		case "hotkeys":
		case "help":
			return { kind: "help" };
		case "new":
			return { kind: "rpc", command: "new_session" };
		case "compact":
			return { kind: "rpc", command: "compact", arg };
		case "clone":
			return { kind: "rpc", command: "clone" };
		case "session":
			return { kind: "rpc", command: "get_session_stats" };
		case "export":
			return { kind: "rpc", command: "export_html", arg };
		case "name":
			return arg
				? { kind: "rpc", command: "set_session_name", arg }
				: { kind: "usage", text: "Usage: /name <session name>" };
		case "thinking":
			return arg && THINKING_LEVELS.has(arg)
				? { kind: "rpc", command: "set_thinking_level", arg }
				: { kind: "usage", text: `Usage: /thinking <${[...THINKING_LEVELS].join("|")}>` };
		case "model":
			return arg?.includes("/")
				? { kind: "rpc", command: "set_model", arg }
				: {
						kind: "usage",
						text: "Usage: /model <provider/model>. The model selector is not available in OpenTUI.",
					};
	}
	if (UNSUPPORTED_COMMANDS.has(name)) return { kind: "unsupported", name };
	return { kind: "prompt", text: input };
}
