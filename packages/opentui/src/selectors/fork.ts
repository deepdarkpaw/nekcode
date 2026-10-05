import { UserMessageSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/user-message-selector";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const forkSelector = defineSelector<void, string>({
	id: "fork",
	open(ctx) {
		const messages = ctx.session.getUserMessagesForForking();
		return openHosted<string>(ctx, (done) => {
			const selector = new UserMessageSelectorComponent(
				messages.map((message) => ({ id: message.entryId, text: message.text })),
				(entryId) => done(entryId),
				() => done(undefined),
				messages.at(-1)?.entryId,
			);
			// Keys go to the message list, as in the interactive mode.
			return { component: selector, focus: selector.getMessageList() };
		});
	},
});
