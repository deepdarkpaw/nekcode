/** One search observation before repeated file paths are folded for model and terminal output. */
export interface SearchOutputLine {
	path: string;
	line: number;
	text: string;
	context?: boolean;
	/** Separate disjoint context windows without implying that the omitted lines are adjacent. */
	breakBefore?: boolean;
}

/** Group repeated file paths only when the heading and indented rows use fewer bytes than inline paths. */
export function formatSearchOutput(lines: readonly SearchOutputLine[]): string {
	const files = new Map<string, SearchOutputLine[]>();
	for (const line of lines) {
		const group = files.get(line.path);
		if (group) group.push(line);
		else files.set(line.path, [line]);
	}
	const output: string[] = [];
	for (const [path, rows] of files) {
		const inline = rows
			.map(
				(row) =>
					`${row.breakBefore ? "--\n" : ""}${path}${row.context ? "-" : ":"}${row.line}${row.context ? "-" : ":"} ${row.text}`,
			)
			.join("\n");
		if (rows.length === 1) {
			output.push(inline);
			continue;
		}
		const grouped = `${path}:\n${rows
			.map((row) => `${row.breakBefore ? "  --\n" : ""}  ${row.line}${row.context ? "-" : ":"} ${row.text}`)
			.join("\n")}`;
		output.push(Buffer.byteLength(grouped) < Buffer.byteLength(inline) ? grouped : inline);
	}
	return output.join("\n");
}

/** Fold repeated parent directories in a normalized path list, leaving short or singleton groups unchanged. */
export function formatPathList(paths: readonly string[]): string {
	const directories = new Map<string, string[]>();
	for (const path of paths) {
		const slash = path.lastIndexOf("/", path.endsWith("/") ? path.length - 2 : path.length - 1);
		const directory = path.slice(0, slash + 1);
		const group = directories.get(directory);
		if (group) group.push(path);
		else directories.set(directory, [path]);
	}
	const output: string[] = [];
	for (const [directory, entries] of directories) {
		const inline = entries.join("\n");
		if (!directory || entries.length === 1) {
			output.push(inline);
			continue;
		}
		const grouped = `${directory}\n${entries.map((entry) => `  ${entry.slice(directory.length)}`).join("\n")}`;
		output.push(Buffer.byteLength(grouped) < Buffer.byteLength(inline) ? grouped : inline);
	}
	return output.join("\n");
}
