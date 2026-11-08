import { homedir } from "node:os";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import {
	applyIsolatedEnvironment,
	createPiDocumentationEvalHarness,
	DOCUMENTATION_EVAL_TOOLS,
	excludePiDocumentation,
	includePiDocumentation,
	resolveDocumentationVariant,
	resolveModelSelection,
	verifySystemPrompt,
} from "../src/harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ NEK_PROVIDER: "openai-codex", NEK_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults", () => {
		expect(resolveModelSelection(undefined, { NEK_PROVIDER: " openai-codex ", NEK_MODEL: " gpt-5.6-sol " })).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([{}, { NEK_PROVIDER: "openai-codex" }, { NEK_MODEL: "gpt-5.6-sol" }])(
		"rejects incomplete model selection",
		(environment) => {
			expect(() => resolveModelSelection(undefined, environment)).toThrow("Select a harness model explicitly");
		},
	);
});

describe("isolateProcessEnvironment", () => {
	it("removes runner metadata and restores the process environment", () => {
		vi.stubEnv("PI_EVAL_VARIANT", "with_docs");
		vi.stubEnv("PI_EVAL_ARTIFACT_DIR", "/tmp/artifacts");
		const oldHome = process.env.HOME;
		try {
			const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
			try {
				expect(homedir()).toBe("/tmp/eval-home");
				expect(process.env.NEK_CODING_AGENT_DIR).toBe("/tmp/eval-agent");
				expect(process.env.PI_EVAL_VARIANT).toBeUndefined();
				expect(process.env.PI_EVAL_ARTIFACT_DIR).toBeUndefined();
			} finally {
				restore();
			}
			expect(process.env.HOME).toBe(oldHome);
			expect(process.env.PI_EVAL_VARIANT).toBe("with_docs");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("documentation variant", () => {
	it.each(["without_docs", "with_docs"] as const)("accepts %s", (variant) => {
		expect(resolveDocumentationVariant(variant)).toBe(variant);
	});

	it.each([undefined, "", "other"])("rejects invalid variant %s", (variant) => {
		expect(() => resolveDocumentationVariant(variant)).toThrow("PI_EVAL_VARIANT");
	});

	it("adds documentation only for treatment and strips it back to the original nek prompt", () => {
		const basePrompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		expect(basePrompt).not.toContain("\n<docs>\n");
		const prompt = includePiDocumentation(basePrompt);
		expect(prompt).toContain("\n<docs>\nPi documentation (read only");
		expect(prompt).toContain("\n<rules>\n");
		expect(prompt).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(prompt).toContain("docs/models.md");

		const stripped = excludePiDocumentation(prompt);
		expect(stripped).toBe(basePrompt);
		expect(stripped).toContain("\n<rules>\n");
		expect(stripped).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(stripped).not.toContain("<docs>");
		expect(stripped).not.toContain("Pi documentation");
		expect(stripped).not.toContain("docs/models.md");
		expect(stripped).not.toContain(getReadmePath());
		expect(stripped).not.toContain(getDocsPath());
		expect(stripped).not.toContain(getExamplesPath());
	});

	it("verifies the prompt that was sent", () => {
		const basePrompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		const prompt = includePiDocumentation(basePrompt);
		const stripped = excludePiDocumentation(prompt);

		expect(verifySystemPrompt(prompt, { name: "with_docs", expectedPiDocumentation: true })).toBe(prompt);
		expect(verifySystemPrompt(stripped, { name: "without_docs", expectedPiDocumentation: false })).toBe(stripped);
		expect(() => verifySystemPrompt(prompt, { name: "without_docs", expectedPiDocumentation: false })).toThrow(
			"does not match",
		);
	});

	it("fails closed when prompt markers are missing or duplicated", () => {
		expect(() => includePiDocumentation("Instructions")).toThrow("no working-directory section");
		expect(() => includePiDocumentation("\n<docs>\nexisting\n</docs>\n<cwd>\n/workspace\n</cwd>")).toThrow(
			"already has a documentation section",
		);
		expect(() => excludePiDocumentation("Instructions")).toThrow("no Pi documentation section");
		expect(() => excludePiDocumentation("\n<docs>\nPi documentation\n</docs>")).toThrow(
			"no working-directory section",
		);
	});

	it("rejects documentation harnesses outside the container sandbox", () => {
		expect(() => createPiDocumentationEvalHarness()).toThrow("isolated container sandbox");
	});
});
