import { normalizeToLF } from "./edit-diff.ts";

const DESANITIZATIONS: Record<string, string> = {
	"<fnr>": "<function_results>",
	"<n>": "<name>",
	"</n>": "</name>",
	"<o>": "<output>",
	"</o>": "</output>",
	"<e>": "<error>",
	"</e>": "</error>",
	"<s>": "<system>",
	"</s>": "</system>",
	"<r>": "<result>",
	"</r>": "</result>",
};

/** Input needed to validate one exact replacement against decoded, LF-normalized content. */
export interface EditTextInput {
	filePath: string;
	oldString: string;
	newString: string;
	replaceAll: boolean;
}

/** Validated strings used by the replacement and diff stages. */
export interface ValidatedEditText {
	actualOldString: string;
	newString: string;
}

function desanitize(value: string): string {
	let result = value;
	for (const [from, to] of Object.entries(DESANITIZATIONS)) result = result.replaceAll(from, to);
	return result;
}

function stripTrailingWhitespace(value: string): string {
	return value
		.split(/(\r\n|\n|\r)/)
		.map((part, index) => (index % 2 === 0 ? part.replace(/\s+$/g, "") : part))
		.join("");
}

function countOccurrences(content: string, search: string): number {
	return search === "" ? 0 : content.split(search).length - 1;
}

/** Validate exact matching, uniqueness, and Claude Code's replacement-string normalization. */
export function validateEditText(content: string, input: EditTextInput): ValidatedEditText {
	if (input.oldString === input.newString) {
		throw new Error("No changes to make: old_string and new_string are exactly the same.");
	}
	if (input.oldString === "") {
		if (content !== "") throw new Error("Cannot create new file - file already exists.");
		return { actualOldString: "", newString: input.newString };
	}

	const normalizedOldString = normalizeToLF(input.oldString);
	const normalizedInputNewString = normalizeToLF(input.newString);
	const isMarkdown = /\.(md|mdx)$/i.test(input.filePath);
	const directMatch = content.includes(normalizedOldString);
	const actualOldString =
		normalizedOldString === ""
			? ""
			: directMatch
				? normalizedOldString
				: content.includes(desanitize(normalizedOldString))
					? desanitize(normalizedOldString)
					: "";
	if (actualOldString === "" && normalizedOldString !== "") {
		throw new Error(`String to replace not found in file.\nString: ${input.oldString}`);
	}
	const normalizedNewString = directMatch ? normalizedInputNewString : desanitize(normalizedInputNewString);
	const newString = isMarkdown ? normalizedNewString : stripTrailingWhitespace(normalizedNewString);

	const matches = countOccurrences(content, actualOldString);
	if (matches > 1 && !input.replaceAll) {
		throw new Error(
			`Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${input.oldString}`,
		);
	}
	return { actualOldString, newString };
}

/** Apply one validated replacement using a closure so `$&`, `$1`, and `$$` remain literal text. */
export function applyEditToFile(
	content: string,
	actualOldString: string,
	newString: string,
	replaceAll: boolean,
): string {
	if (actualOldString === "") return newString;
	const search =
		newString === "" && !actualOldString.endsWith("\n") && content.includes(`${actualOldString}\n`)
			? `${actualOldString}\n`
			: actualOldString;
	return replaceAll ? content.replaceAll(search, () => newString) : content.replace(search, () => newString);
}
