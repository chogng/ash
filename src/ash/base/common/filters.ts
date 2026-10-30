/** A half-open UTF-16 range in the matched label. */
export interface IMatch {
	start: number;
	end: number;
}

/** Finds the first case-insensitive contiguous occurrence. */
export function matchesContiguousSubString(word: string, wordToMatchAgainst: string): IMatch[] | null {
	const pattern = word.toLowerCase();
	const target = lowercaseLabel(wordToMatchAgainst);
	const start = target.text.indexOf(pattern);
	return start < 0 ? null : [sourceRange(target, start, start + pattern.length)];
}

/** Matches an ordered subsequence, merging adjacent character ranges. */
export function matchesSubString(word: string, wordToMatchAgainst: string): IMatch[] | null {
	const pattern = word.toLowerCase();
	const target = lowercaseLabel(wordToMatchAgainst);
	const matches: IMatch[] = [];
	let cursor = 0;
	// Labels and their highlight ranges use UTF-16 offsets, including both units of an astral character.
	for (let index = 0; index < pattern.length; index++) {
		const found = target.text.indexOf(pattern[index]!, cursor);
		if (found < 0) return null;
		const match = sourceRange(target, found, found + 1);
		const previous = matches.at(-1);
		if (previous && previous.end >= match.start) previous.end = Math.max(previous.end, match.end);
		else matches.push(match);
		cursor = found + 1;
	}
	return matches;
}

/** Matches a contiguous prefix at a word boundary, or prefixes across successive words. */
export function matchesWords(word: string, target: string, contiguous = false): IMatch[] | null {
	if (!target) { return null; }
	if (!contiguous) { return matchWordPrefixes(word, target); }
	for (const start of wordStarts(target)) {
		const match = matchesContiguousSubString(word, target.slice(start));
		if (match?.[0]?.start === 0) { return match.map(range => ({ start: start + range.start, end: start + range.end })); }
	}
	return null;
}

/** Matches identifier word prefixes, including initials across camel-case transitions. */
export function matchesCamelCase(word: string, camelCaseWord: string): IMatch[] | null {
	return camelCaseWord ? matchWordPrefixes(word, camelCaseWord) : null;
}

function wordStarts(value: string): number[] {
	const starts: number[] = [];
	let offset = 0;
	let previous = '';
	for (const character of value) {
		if (/[\p{L}\p{N}]/u.test(character) && (!/[\p{L}\p{N}]/u.test(previous) || /\p{Ll}/u.test(previous) && /\p{Lu}/u.test(character) || /\p{L}/u.test(previous) && /\p{N}/u.test(character))) { starts.push(offset); }
		offset += character.length;
		previous = character;
	}
	return starts;
}

function matchWordPrefixes(word: string, target: string): IMatch[] | null {
	const pattern = word.replace(/\s+/gu, '').toLowerCase();
	if (!pattern) { return []; }
	const starts = wordStarts(target);
	const matches: IMatch[] = [];
	let cursor = 0;
	for (const [index, start] of starts.entries()) {
		const end = starts[index + 1] ?? target.length;
		const segment = lowercaseLabel(target.slice(start, end));
		let length = 0;
		while (cursor < pattern.length && segment.text[length] === pattern[cursor]) { length++; cursor++; }
		if (length) { const range = sourceRange(segment, 0, length); matches.push({ start: start + range.start, end: start + range.end }); }
		if (cursor === pattern.length) { return matches; }
	}
	return null;
}

interface LowercaseLabel {
	readonly text: string;
	readonly sourceRanges?: readonly IMatch[];
}

function lowercaseLabel(source: string): LowercaseLabel {
	const text = source.toLowerCase();
	if (text.length === source.length) return { text };
	// Lowercasing can expand one source character, such as İ into i + combining dot.
	// Keep whole-string casing semantics, but project each expanded unit onto that source character.
	const sourceRanges: IMatch[] = [];
	let offset = 0;
	for (const character of source) {
		const length = character.toLowerCase().length;
		for (let index = 0; index < length; index++) {
			sourceRanges.push(length === character.length
				? { start: offset + index, end: offset + index + 1 }
				: { start: offset, end: offset + character.length });
		}
		offset += character.length;
	}
	return { text, sourceRanges };
}

function sourceRange(target: LowercaseLabel, start: number, end: number): IMatch {
	if (!target.sourceRanges || start === end) return { start, end };
	return { start: target.sourceRanges[start]!.start, end: target.sourceRanges[end - 1]!.end };
}
