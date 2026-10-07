export const Mimes = Object.freeze({
	text: 'text/plain',
	binary: 'application/octet-stream',
	unknown: 'application/unknown',
	markdown: 'text/markdown',
	latex: 'text/latex',
	uriList: 'text/uri-list',
	html: 'text/html',
});

const mimePattern = /^([^/\s]+)\/([^;\s]+)(;.*)?$/u;

export function normalizeMimeType(value: string): string;
export function normalizeMimeType(value: string, strict: true): string | undefined;
export function normalizeMimeType(value: string, strict?: true): string | undefined {
	const match = mimePattern.exec(value);
	if (!match) return strict ? undefined : value;
	return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}${match[3] ?? ''}`;
}

export function isTextStreamMime(value: string): boolean {
	return value === 'application/vnd.code.notebook.stdout' || value === 'application/vnd.code.notebook.stderr';
}
