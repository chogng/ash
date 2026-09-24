export interface TextWordSegment {
	readonly start: number;
	readonly end: number;
	readonly wordLike: boolean;
}

const graphemeSegmenter = createSegmenter("grapheme");
const wordSegmenter = createSegmenter("word");

/** Returns ordered UTF-16 caret boundaries including zero and text length. */
export function getTextGraphemeBoundaries(text: string): readonly number[] {
	const boundaries = [0];
	if (graphemeSegmenter) {
		for (const segment of graphemeSegmenter.segment(text)) {
			pushBoundary(boundaries, segment.index + segment.segment.length);
		}
	} else {
		let offset = 0;
		for (const character of text) {
			offset += character.length;
			boundaries.push(offset);
		}
	}
	pushBoundary(boundaries, text.length);
	return Object.freeze(boundaries);
}

/**
 * Returns ordered word, whitespace, and punctuation segments for one line.
 */
export function getTextWordSegments(text: string): readonly TextWordSegment[] {
	if (wordSegmenter) {
		return Object.freeze([...wordSegmenter.segment(text)].map(segment =>
			Object.freeze({
				start: segment.index,
				end: segment.index + segment.segment.length,
				wordLike: segment.isWordLike === true,
			})
		));
	}
	const result: Array<{
		start: number;
		end: number;
		wordLike: boolean;
	}> = [];
	let offset = 0;
	let activeKind: TextSegmentKind | undefined;
	for (const value of text) {
		const kind = classify(value);
		if (kind !== activeKind) {
			result.push({
				start: offset,
				end: offset + value.length,
				wordLike: kind === TextSegmentKind.Word,
			});
			activeKind = kind;
		} else {
			result[result.length - 1]!.end += value.length;
		}
		offset += value.length;
	}
	return Object.freeze(result.map(segment => Object.freeze(segment)));
}

enum TextSegmentKind {
	Word,
	Whitespace,
	Other,
}

function classify(value: string): TextSegmentKind {
	if (/^[\p{L}\p{M}\p{N}_]$/u.test(value)) return TextSegmentKind.Word;
	if (/^\s$/u.test(value)) return TextSegmentKind.Whitespace;
	return TextSegmentKind.Other;
}

function createSegmenter(granularity: Intl.SegmenterOptions["granularity"]): Intl.Segmenter | undefined {
	try {
		return typeof Intl.Segmenter === "function"
			? new Intl.Segmenter(undefined, { granularity })
			: undefined;
	} catch {
		return undefined;
	}
}

function pushBoundary(boundaries: number[], boundary: number): void {
	if (boundary > boundaries[boundaries.length - 1]!) {
		boundaries.push(boundary);
	}
}
