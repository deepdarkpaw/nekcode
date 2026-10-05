import { existsSync } from "node:fs";
import type { ModeContext } from "../mode/mode-context.ts";

export function firstPathArgument(args: string | undefined): string | undefined {
	if (!args) return undefined;
	const value = args.trim();
	if (!value) return undefined;
	if (value[0] === '"' || value[0] === "'") {
		const quote = value[0];
		const end = value.indexOf(quote, 1);
		return end < 0 ? undefined : value.slice(1, end);
	}
	return value.split(/\s+/)[0];
}

export function reportOperationError(ctx: ModeContext, prefix: string, error: unknown): void {
	ctx.showError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

export function existingPathCompletion(prefix: string): { value: string; label: string }[] | null {
	if (!prefix || !existsSync(prefix)) return null;
	return [{ value: prefix, label: prefix }];
}
