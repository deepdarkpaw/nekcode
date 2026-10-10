/**
 * Child process for durable session store tests. `import <jsonl>` opens a JSONL session, which imports it; the parent
 * kills it mid-import. `hold <database>` opens a session and keeps it pinned, holding the session lock, until killed.
 */
import { SessionManager } from "../../../src/core/session-manager.ts";

const [mode, path] = process.argv.slice(2);
if (mode === undefined || path === undefined) throw new Error("usage: session-child <import|hold> <path>");

function mark(name: string): void {
	process.stdout.write(`MARK ${name}\n`);
}

setInterval(() => {}, 1000);
if (mode === "import") {
	mark("importing");
	SessionManager.open(path);
	mark("imported");
} else if (mode === "hold") {
	const session = SessionManager.open(path);
	await session.durableStore().pin();
	mark("held");
} else {
	throw new Error(`Unknown mode ${mode}`);
}
