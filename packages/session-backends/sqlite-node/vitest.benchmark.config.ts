import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiIndex = fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url));
const agentIndex = fileURLToPath(new URL("../../agent/src/index.ts", import.meta.url));
const agentSessionTesting = fileURLToPath(
	new URL("../../agent/src/harness/session/testing/index.ts", import.meta.url),
);

export default defineConfig({
	test: {
		environment: "node",
		benchmark: {
			include: ["benchmark/session/**/*.bench.ts"],
			reporters: ["verbose"],
		},
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-agent-core\/session\/testing$/, replacement: agentSessionTesting },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
