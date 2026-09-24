/** Counts indentation columns using the configured tab width. */
export function getSpaceCnt(value: string, tabSize: number): number {
	validateTabSize(tabSize);
	let columns = 0;
	for (const character of value) {
		columns += character === '\t' ? tabSize - columns % tabSize : 1;
	}
	return columns;
}

/** Builds indentation with tabs where requested and spaces for the remainder. */
export function generateIndent(spaceCount: number, tabSize: number, insertSpaces: boolean): string {
	validateTabSize(tabSize);
	if (!Number.isFinite(spaceCount)) throw new TypeError('Indentation width must be finite');
	const columns = Math.max(0, Math.trunc(spaceCount));
	if (insertSpaces) return ' '.repeat(columns);
	return '\t'.repeat(Math.floor(columns / tabSize)) + ' '.repeat(columns % tabSize);
}

function validateTabSize(tabSize: number): void {
	if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('Tab size must be a positive safe integer');
}
