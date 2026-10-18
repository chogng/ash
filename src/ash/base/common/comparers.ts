const fileNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compares whole filenames naturally, with code-unit ordering for equivalent names. */
export function compareFileNames(one: string | null, other: string | null, _caseSensitive = false): number {
	// The legacy caseSensitive argument is accepted for compatibility; filename
	// equivalence always ignores case and accents before the deterministic tie-break.
	return fileNameCollator.compare(one ?? '', other ?? '') || compareFileNamesUnicode(one, other);
}

/** Compares whole filenames by UTF-16 code units, without numeric collation. */
export function compareFileNamesUnicode(one: string | null, other: string | null): number {
	const left = one ?? '';
	const right = other ?? '';
	return left < right ? -1 : left > right ? 1 : 0;
}
