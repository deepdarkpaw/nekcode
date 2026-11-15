import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	deleteKittyImage,
	encodeITerm2,
	encodeKitty,
	getImageLineExtent,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
	stripImageSequences,
} from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	writes = "";
	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}
const component = (lines: string[]) => ({ render: () => lines, invalidate: () => {} });

describe("terminal image overlay ownership", () => {
	for (const Screen of [TuiMainScreen, TuiAltScreen]) {
		it(`hides and restores covered images in ${Screen.name}`, async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			const terminal = new RecordingTerminal(20, 6);
			const tui = new Screen(terminal);
			const imageId = Screen === TuiAltScreen ? 12010 : 11584;
			registerKittyImageMetadata({ imageId, columns: 4, rows: 3, widthPx: 100, heightPx: 100 });
			const image = encodeKitty("AAAA", { columns: 4, rows: 3, imageId, moveCursor: false });
			const root = component(["top", image, "", "", "after", ""]);
			if (tui instanceof TuiAltScreen) tui.setLayoutRoot(root);
			else tui.addChild(root);
			try {
				tui.start();
				await terminal.waitForRender();
				terminal.writes = "";
				const overlay = tui.showOverlay(component(["PANEL"]), { row: 2, col: 2, width: 8 });
				await terminal.waitForRender();
				assert.equal(terminal.getViewport()[2]?.trimEnd(), "  PANEL");
				assert.ok(!terminal.writes.includes("\x1b_Ga=T"));
				if (tui instanceof TuiMainScreen) assert.ok(terminal.writes.includes(deleteKittyImage(imageId)));
				terminal.writes = "";
				overlay.hide();
				await terminal.waitForRender();
				assert.ok(terminal.writes.includes(`i=${imageId}`));
				if (tui instanceof TuiAltScreen) {
					terminal.writes = "";
					terminal.resize(20, 8);
					await terminal.waitForRender();
					assert.ok(terminal.writes.includes("\x1b_Ga=p,q=2"));
					assert.ok(!terminal.writes.includes("\x1b[2J"));
				}
			} finally {
				tui.stop();
				resetCapabilitiesCache();
			}
		});
	}

	it("measures and strips Kitty and iTerm2 extents without discarding text", () => {
		const kitty = `  ${encodeKitty("AAAA", { columns: 4, rows: 3, imageId: 12011 })}`;
		assert.deepEqual(getImageLineExtent(kitty), { firstRow: 0, lastRow: 2, startCol: 2, endCol: 6 });
		assert.equal(stripImageSequences(kitty), "  ");
		const iterm = `  \x1b[2A${encodeITerm2("AAAA", { width: 4 })}`;
		assert.deepEqual(getImageLineExtent(iterm), { firstRow: -2, lastRow: 0, startCol: 2, endCol: 6 });
		assert.equal(stripImageSequences(iterm), "  ");
	});
});
