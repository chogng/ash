function spreadsheetText(text: string): string {
	// Quoting preserves field boundaries, but spreadsheet apps can still
	// evaluate formulas. The text marker precedes any ignorable whitespace.
	return /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(text) ? "'" + text : text;
}

export function serializeChatMarkdownTableCsv(rows: readonly (readonly string[])[]): string {
	return rows.map(row => row.map(text => '"' + spreadsheetText(text).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
}

export function serializeChatMarkdownTableTsv(rows: readonly (readonly string[])[]): string {
	return rows.map(row => row.map(text => {
		// Plain-text paste targets may split on every tab or line break.
		const value = spreadsheetText(text.replace(/[\t\r\n]+/g, ' '));
		return value.startsWith('"') ? '"' + value.replaceAll('"', '""') + '"' : value;
	}).join('\t')).join('\n');
}
