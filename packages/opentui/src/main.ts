/**
 * Entry point of the OpenTUI frontend (runs on Bun).
 *
 * Started by `nek --ui opentui`, which passes the backend command in `NEK_OPENTUI_BACKEND`. With
 * `--smoke`, it runs the RPC handshake, renders one frame to an offscreen test renderer, prints a
 * summary, and exits: a non-interactive check of the whole chain.
 */

import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app.ts";
import { RpcClient, spawnBackend } from "./rpc/client.ts";
import { loadPalette } from "./theme/load.ts";

const BACKEND_ENV = "NEK_OPENTUI_BACKEND";
const THEME_ENV = "NEK_OPENTUI_THEME_PATH";
const MESSAGES_ENV = "NEK_OPENTUI_INITIAL_MESSAGES";

function parseStringArray(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function fail(message: string): never {
	process.stderr.write(`nek opentui: ${message}\n`);
	process.exit(1);
}

async function main(): Promise<void> {
	const smoke = process.argv.includes("--smoke");
	const backendCommand = parseStringArray(process.env[BACKEND_ENV]);
	if (!backendCommand || backendCommand.length === 0) {
		fail(`${BACKEND_ENV} is not set. Start the frontend with \`nek --ui opentui\`.`);
	}
	const palette = loadPalette(process.env[THEME_ENV]);
	const initialMessages = smoke ? [] : (parseStringArray(process.env[MESSAGES_ENV]) ?? []);
	const client = new RpcClient(spawnBackend(backendCommand, { cwd: process.cwd(), env: process.env }));

	if (smoke) {
		await runSmoke(client, palette);
		return;
	}

	const renderer: CliRenderer = await createCliRenderer({
		exitOnCtrlC: false,
		useMouse: true,
		targetFps: 30,
		backgroundColor: palette.base,
		useKittyKeyboard: { disambiguate: true, alternateKeys: true },
	});
	let finished = false;
	const finish = async (code: number) => {
		if (finished) return;
		finished = true;
		app.dispose();
		renderer.destroy();
		const backendCode = await client.shutdown();
		process.exit(code !== 0 ? code : (backendCode ?? 0));
	};
	const app = new App({
		renderer,
		client,
		palette,
		cwd: process.cwd(),
		initialMessages,
		onExit: (code) => void finish(code),
	});
	renderer.start();
	try {
		await app.start();
	} catch (error) {
		// The backend failed to start; the transcript shows its exit notice. Keep the UI so it can be read.
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`nek opentui: backend handshake failed: ${message}\n`);
	}
}

/** Handshake, one rendered frame, clean shutdown. Prints the frame and exits non-zero on failure. */
async function runSmoke(client: RpcClient, palette: ReturnType<typeof loadPalette>): Promise<void> {
	const started = Date.now();
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 });
	let exitCode = 0;
	const app = new App({ renderer, client, palette, cwd: process.cwd(), initialMessages: [], onExit: () => {} });
	try {
		await app.start();
		app.sync();
		await renderOnce();
		const frame = captureCharFrame();
		const state = app.viewState;
		process.stdout.write(`${frame}\n`);
		process.stdout.write(
			`smoke: handshake ok in ${Date.now() - started} ms · backend=${state.backend.status} · model=${state.footer.model ?? "none"} · blocks=${state.blocks.length}\n`,
		);
		if (state.backend.status !== "ready") exitCode = 1;
		if (!frame.includes("AGENT") && !frame.includes("PLAN")) {
			process.stdout.write("smoke: footer badge missing from the frame\n");
			exitCode = 1;
		}
	} catch (error) {
		process.stdout.write(
			`smoke: failed: ${error instanceof Error ? error.message : String(error)}\n${client.stderr}\n`,
		);
		exitCode = 1;
	} finally {
		app.dispose();
		renderer.destroy();
	}
	const backendCode = await client.shutdown();
	process.stdout.write(`smoke: backend exited with code ${backendCode}\n`);
	process.exit(exitCode !== 0 ? exitCode : (backendCode ?? 0));
}

await main();
