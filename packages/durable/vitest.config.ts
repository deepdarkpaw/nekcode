import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));
const aiSrcModels = fileURLToPath(new URL("../ai/src/models.ts", import.meta.url));

/** Workspace source aliases come from vitest.base.ts so tests run without building pi-ai or chord dist. */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
		},
		resolve: {
			conditions: ["source"],
			alias: [
				{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
				{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
				{ find: /^@earendil-works\/pi-ai\/models$/, replacement: aiSrcModels },
			],
		},
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
