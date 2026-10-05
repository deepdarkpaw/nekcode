import { ProjectTrustStore } from "@earendil-works/pi-coding-agent/core/trust-manager";
import {
	type TrustSelection,
	TrustSelectorComponent,
} from "@earendil-works/pi-coding-agent/modes/interactive/components/trust-selector";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const trustSelector = defineSelector<void, TrustSelection>({
	id: "trust",
	open(ctx) {
		const cwd = ctx.sessionManager.getCwd();
		const store = new ProjectTrustStore(ctx.runtimeHost.services.agentDir);
		return openHosted<TrustSelection>(
			ctx,
			(done) =>
				new TrustSelectorComponent({
					cwd,
					savedDecision: store.getEntry(cwd),
					projectTrusted: ctx.settingsManager.isProjectTrusted(),
					onSelect: (selection) => {
						store.setMany(selection.updates);
						done(selection);
					},
					onCancel: () => done(undefined),
				}),
		);
	},
});
