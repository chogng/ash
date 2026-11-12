/** Export rendered chat table text without opting cells into spreadsheet formulas. */
export function serializeChatMarkdownTable(rows: readonly (readonly string[])[]): string {
	return rows.map(row => row.map(text => {
		// CSV quoting preserves field boundaries, not spreadsheet text semantics. Put the
		// text marker before all whitespace/controls an importer might ignore. Signed
		// numbers are deliberately text too; chat tables do not carry numeric types.
		const value = /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(text) ? "'" + text : text;
		return '"' + value.replaceAll('"', '""') + '"';
	}).join(',')).join('\r\n') + '\r\n';
}
