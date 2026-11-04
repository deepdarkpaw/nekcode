/** Normalize a server-supplied HTTP(S) URL; never launch local files or custom protocol handlers. */
export function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !URL.canParse(value)) return null;
	const url = new URL(value);
	return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}
