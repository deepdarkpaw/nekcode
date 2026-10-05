import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";

/** Share a session without owning a pi-tui editor, for alternative frontends. */
export async function shareSessionHeadless(session: AgentSession, themeName?: string): Promise<string> {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-share-native-"));
	const htmlPath = path.join(tempDir, "session.html");
	try {
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
		if (auth.status !== 0) throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
		await session.exportToHtml(htmlPath, { themeName });
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const process = spawn("gh", ["gist", "create", "--public=false", htmlPath]);
			let stdout = "";
			let stderr = "";
			process.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			process.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			process.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		if (result.code !== 0) throw new Error(result.stderr.trim() || "Unknown error");
		const gistUrl = result.stdout.trim();
		const id = gistUrl.split("/").pop();
		if (!id) throw new Error("Failed to parse gist ID from gh output");
		return getShareViewerUrl(id);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
