/**
 * `defaultTools` selection: plain lists, `+name`/`-name` entries, and unknown-name reporting.
 */

import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES, resolveDefaultTools } from "../src/core/tool-names.ts";

describe("resolveDefaultTools", () => {
	it("uses an unprefixed list as the selection", () => {
		expect(resolveDefaultTools(["grep", "find"]).names).toEqual(["grep", "find"]);
		expect(resolveDefaultTools(["grep", "find"]).unknown).toEqual([]);
	});

	it("uses the built-in defaults when every entry is prefixed", () => {
		expect(resolveDefaultTools(["+powershell"]).names).toEqual([...DEFAULT_ACTIVE_TOOL_NAMES, "powershell"]);
		expect(resolveDefaultTools(["-web_search"]).names).toEqual(
			DEFAULT_ACTIVE_TOOL_NAMES.filter((name) => name !== "web_search"),
		);
	});

	it("adds and removes from an explicit base list in entry order", () => {
		expect(resolveDefaultTools(["read", "+grep", "+powershell", "-read"]).names).toEqual(["grep", "powershell"]);
		expect(resolveDefaultTools(["read", "+read", "-grep"]).names).toEqual(["read"]);
	});

	it("keeps an empty list empty", () => {
		expect(resolveDefaultTools([]).names).toEqual([]);
		expect(resolveDefaultTools(["  "]).names).toEqual([]);
	});

	it("reports unknown names once, with or without a prefix", () => {
		const resolved = resolveDefaultTools(["read", "nope", "+missing", "-gone", "nope"]);

		expect(resolved.names).toEqual(["read"]);
		expect(resolved.unknown).toEqual(["nope", "missing", "gone"]);
	});

	it("accepts a custom known set and default selection", () => {
		expect(resolveDefaultTools(["+b"], new Set(["a", "b"]), ["a"]).names).toEqual(["a", "b"]);
	});
});

describe("settings defaultTools", () => {
	it("resolves prefixed entries through the settings manager", () => {
		const manager = SettingsManager.inMemory({ defaultTools: ["read", "+powershell"] });

		expect(manager.getDefaultTools()).toEqual(["read", "powershell"]);
		expect(manager.getUnknownDefaultTools()).toEqual([]);
	});

	it("keeps an empty list and an unset list distinct", () => {
		expect(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools()).toEqual([]);
		expect(SettingsManager.inMemory().getDefaultTools()).toBeUndefined();
	});

	it("exposes unknown names for diagnostics", () => {
		const manager = SettingsManager.inMemory({ defaultTools: ["read", "not_a_tool"] });

		expect(manager.getDefaultTools()).toEqual(["read"]);
		expect(manager.getUnknownDefaultTools()).toEqual(["not_a_tool"]);
	});
});
