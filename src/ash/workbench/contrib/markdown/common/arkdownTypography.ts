export const enum DocsFontFamily {
	Serif = 'serif',
	Sans = 'sans',
}

export interface DocsTypography {
	readonly headings: DocsFontFamily;
	readonly text: DocsFontFamily;
}

export const defaultDocsTypography: DocsTypography = { headings: DocsFontFamily.Sans, text: DocsFontFamily.Sans };

/** Only a bounded, complete typography record at the start of a document is metadata. */
export function readDocsTypography(source: string): { readonly value: DocsTypography; readonly end: number; } | undefined {
	const match = /^```ash-typography\r?\n([^\r\n]*)\r?\n```(?:\r?\n|$)/u.exec(source.slice(0, 513));
	if (!match || match[0].length > 512) return undefined;
	try {
		const value: unknown = JSON.parse(match[1]);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const fields = value as Record<string, unknown>;
		const family = (value: unknown): value is DocsFontFamily => value === DocsFontFamily.Serif || value === DocsFontFamily.Sans;
		if (Object.keys(fields).length !== 2 || !family(fields.headings) || !family(fields.text)) return undefined;
		return { value: { headings: fields.headings, text: fields.text }, end: match[0].length };
	} catch { return undefined; }
}

export function writeDocsTypography(value: DocsTypography): string {
	return '```ash-typography\n' + JSON.stringify(value) + '\n```';
}
