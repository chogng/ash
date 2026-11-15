/** A Markdown fenced block keeps dropdown options and selection in the same document and undo history. */
export interface DocsDropdown {
	readonly label: string;
	readonly options: readonly string[];
	readonly selected: number;
}

export function parseDocsDropdown(value: unknown): DocsDropdown | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const { label, options, selected } = value as Record<string, unknown>;
	if (typeof label !== 'string' || !label.trim() || label.length > 100 || !Array.isArray(options) || options.length < 2 || options.length > 20
		|| !options.every(option => typeof option === 'string' && option.trim().length > 0 && option.length <= 100)
		|| !Number.isInteger(selected) || (selected as number) < 0 || (selected as number) >= options.length) return undefined;
	return { label, options, selected: selected as number };
}

export function readDocsDropdown(source: string): DocsDropdown | undefined {
	if (source.length > 8192) return undefined;
	const match = /^```ash-dropdown\r?\n([\s\S]*?)\r?\n```\r?\n?$/u.exec(source);
	if (!match) return undefined;
	try { return parseDocsDropdown(JSON.parse(match[1])); } catch { return undefined; }
}

export function writeDocsDropdown(value: DocsDropdown): string {
	return '```ash-dropdown\n' + JSON.stringify(value) + '\n```';
}
