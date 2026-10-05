/**
 * Bun entry of the OpenTUI frontend.
 *
 * `nek --ui opentui` (Node) spawns `bun packages/opentui/src/main.ts <args>`. This process runs the
 * regular coding-agent `main()` with the OpenTUI mode factory: argument parsing, session setup,
 * extensions, and print/rpc modes behave exactly as in `nek`; only the interactive UI differs.
 */

import { setupCli } from "@earendil-works/pi-coding-agent/cli/setup";
import { main } from "@earendil-works/pi-coding-agent/main";
import { createOpenTuiModeFactory } from "./mode/opentui-mode.ts";
import { RendererHost } from "./mode/renderer-host.ts";
import { createStartupHost } from "./mode/startup-host.ts";
import { createStartupUiHooks } from "./startup/index.ts";

setupCli();
const rendererHost = new RendererHost();

await main(process.argv.slice(2), {
	createInteractiveMode: createOpenTuiModeFactory(rendererHost),
	startupUi: createStartupUiHooks(createStartupHost(rendererHost)),
});
