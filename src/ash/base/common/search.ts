/** Adapts replacement casing to the full match; capture groups do not affect it. */
export function buildReplaceStringWithCasePreserved(matches: string[] | null, pattern: string): string {
	return preserveLetterCase(matches?.[0] ?? '', pattern);
}

function preserveLetterCase(source: string, replacement: string): string {
	if (!source || !replacement) {
		return replacement;
	}

	// Segment only when one separator gives an unambiguous word correspondence.
	const separators = ['-', '_'].filter(separator => source.includes(separator) && source.split(separator).length === replacement.split(separator).length);
	if (separators.length === 1) {
		const separator = separators[0]!;
		const words = source.split(separator);
		return replacement
			.split(separator)
			.map((word, index) => preserveLetterCase(words[index]!, word))
			.join(separator);
	}

	if (source === source.toUpperCase()) {
		return replacement.toUpperCase();
	}
	if (source === source.toLowerCase()) {
		return replacement.toLowerCase();
	}

	const first = source.charAt(0);
	if (first.toLowerCase() !== first.toUpperCase()) {
		const initial = first === first.toUpperCase() ? replacement.charAt(0).toUpperCase() : replacement.charAt(0).toLowerCase();
		return initial + replacement.slice(1);
	}
	return replacement;
}
