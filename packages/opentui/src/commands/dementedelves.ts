import { EarendilAnnouncementComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/earendil-announcement";
import type { CommandDefinition } from "./registry.ts";

export const dementedelvesCommand: CommandDefinition = {
	name: "dementedelves",
	acceptsArgs: false,
	clearEditor: "after",
	hidden: true,
	run: (ctx) => {
		ctx.transcript.appendComponent(new EarendilAnnouncementComponent());
	},
};
