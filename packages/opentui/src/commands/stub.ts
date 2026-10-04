/**
 * Placeholder behavior for commands the OpenTUI interface does not implement yet.
 * Command modules import only types from `registry.ts`, so importing a command module first never
 * hits an import cycle.
 */

import type { ModeContext } from "../mode/mode-context.ts";

export function reportNotImplemented(ctx: ModeContext, name: string): void {
	ctx.showWarning(`/${name} is not implemented in the OpenTUI interface yet`);
}
