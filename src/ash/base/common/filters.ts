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
			sourceRanges.push(length === character.length ? { start: offset + index, end: offset + index + 1 } : { start: offset, end: offset + character.length });
		}
		offset += character.length;
	}
	return { text, sourceRanges };
}

function sourceRange(target: LowercaseLabel, start: number, end: number): IMatch {
	if (!target.sourceRanges || start === end) return { start, end };
	return { start: target.sourceRanges[start]!.start, end: target.sourceRanges[end - 1]!.end };
}
