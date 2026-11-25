/**
 * Just enough YAML for compose files and Taskfiles: the keys of one top-level mapping (the
 * services, the tasks) with their line, and the plain values directly under each key. Block
 * style only, which is what these files use; anything else simply yields no keys.
 */
export interface YamlEntry {
	key: string;
	/** Zero-based line of the key. */
	line: number;
	character: number;
	/** Scalar values one level down, e.g. { image: 'postgres:16', desc: 'Build it' }; '' for a nested block. */
	values: Record<string, string>;
}

// A key ends at the first colon followed by a space or the line end, so "db:migrate:" is one key.
const KEY = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s#'"-][^#]*?))\s*:(?:\s+(.*))?$/;

export function mappingEntries(text: string, parent: string): YamlEntry[] {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => new RegExp(`^${parent}\\s*:\\s*(?:#.*)?$`).test(line));
	if (start < 0) {
		return [];
	}
	const entries: YamlEntry[] = [];
	let childIndent: number | undefined;
	let valueIndent: number | undefined;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(?:#.*)?$/.test(line)) {
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			break;
		}
		childIndent ??= indent;
		if (indent < childIndent) {
			break;
		}
		const match = KEY.exec(line);
		if (indent === childIndent) {
			valueIndent = undefined;
			const key = match && (match[2] ?? match[3] ?? match[4]);
			if (key && /^[\w.:-]+$/.test(key)) {
				entries.push({ key, line: i, character: indent, values: {} });
			}
			continue;
		}
		const current = entries[entries.length - 1];
		if (!current) {
			continue;
		}
		valueIndent ??= indent;
		if (indent === valueIndent && match) {
			// A key with a nested block (build:\n  context: .) is recorded with an empty value.
			current.values[match[2] ?? match[3] ?? match[4]] = match[5] === undefined ? '' : scalar(match[5]);
		}
	}
	return entries;
}

/** A plain YAML scalar without quotes or a trailing comment. */
function scalar(raw: string): string {
	const text = raw.trim();
	const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(text);
	if (quoted) {
		return quoted[2];
	}
	return text.replace(/\s+#.*$/, '');
}
