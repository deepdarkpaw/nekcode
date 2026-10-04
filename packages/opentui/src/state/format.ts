/** Display formatting shared by the view. Pure functions, Node-compatible. */

/** Token counts with 1k = 1000: `950`, `1.2k`, `12k`, `1.5M`. */
export function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count < 0) return "0";
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${trimZero((count / 1000).toFixed(1))}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${trimZero((count / 1_000_000).toFixed(1))}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function trimZero(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/** Elapsed time: `42s`, `3m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `Ns ago` for recent activity, minutes and hours beyond that. */
export function formatAgo(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

/** Home directory replaced by `~`, using forward slashes. */
export function shortenHome(path: string, home: string): string {
	const normalized = path.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/").replace(/\/$/, "");
	if (normalizedHome && (normalized === normalizedHome || normalized.startsWith(`${normalizedHome}/`))) {
		return `~${normalized.slice(normalizedHome.length)}`;
	}
	return normalized;
}

/** Hostname without `www.`, or the input when it is not a URL. */
export function urlDomain(url: string): string {
	if (!URL.canParse(url)) return url;
	return new URL(url).hostname.replace(/^www\./, "");
}

/** First line of a string, cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max: number): string {
	const line = text.split(/\r?\n/, 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
}

/** Compact one-line rendering of tool arguments: `key=value` pairs. */
export function formatArgsInline(args: unknown, max: number): string {
	if (args == null) return "";
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args)
			: ([["args", args]] as [string, unknown][]);
	const text = entries
		.map(
			([key, value]) =>
				`${key}=${typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))}`,
		)
		.join(" ");
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
