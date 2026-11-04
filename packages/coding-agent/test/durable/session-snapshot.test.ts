import { afterAll, describe, expect, it } from "vitest";
import { projectSnapshot, readSessionSnapshot, SnapshotProjection } from "../../src/core/durable/session-snapshot.ts";
import type { SessionEntry } from "../../src/core/session-entries.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { writeFixtures } from "./session-fixtures.ts";
import { tempDir } from "./support.ts";

const { dir, cleanup } = tempDir("snapshot-fold-");
afterAll(cleanup);

describe("shared full/incremental session projection", () => {
	for (const fixture of writeFixtures(dir))
		it(`folds partitions equivalently: ${fixture.name}`, async () => {
			const manager = SessionManager.open(fixture.path);
			await manager.flush();
			const snapshot = readSessionSnapshot(manager.getSessionFile()!);
			const expected = projectSnapshot(snapshot);
			const projection = new SnapshotProjection();
			const entries: SessionEntry[] = [];
			for (let index = 0; index < snapshot.entries.length; index += 17) {
				entries.push(
					...projection.fold({
						conversations: snapshot.conversations,
						entries: snapshot.entries.slice(index, index + 17),
					}).entries,
				);
			}
			expect([projection.header, ...entries]).toEqual(expected.fileEntries);
			expect(projection.placement).toEqual(expected.placement);
			expect(projection.fold(snapshot).entries).toEqual([]);
		});
});
