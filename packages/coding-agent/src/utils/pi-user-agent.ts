import { NEK_VERSION } from "../config.ts";

export function getPiUserAgent(): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `nek/${NEK_VERSION} (${process.platform}; ${runtime}; ${process.arch})`;
}
