import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { type TextSnapshot } from '../core/textChange.js';

export type UnicodeHighlightKind = 'invisible' | 'bidi' | 'confusable';

export interface UnicodeHighlight {
	readonly range: Range;
	readonly kind: UnicodeHighlightKind;
	readonly character: string;
}

/** Finds editor-dangerous Unicode characters in one immutable text version. */
export function computeUnicodeHighlights(snapshot: TextSnapshot, signal?: AbortSignal): readonly UnicodeHighlight[] {
	signal?.throwIfAborted();
	const result: UnicodeHighlight[] = [];
	const text = snapshot.getText();
	// Most source text cannot produce a warning. Let the regexp engine skip it
	// without allocating one string per line or visiting every code point in JS.
	const candidates =
		/[\x00-\x08\x0b\x0c\x0e-\x1f\u00ad\u061c\u200b-\u200d\u202a-\u202e\u2060\u2066-\u2069\ufeff\u0370-\u03ff\u0400-\u04ff]/gu;
	const separators = /\r\n|\r|\n/g;
	let nextSeparator = separators.exec(text);
	let lineNumber = 1;
	let lineStart = 0;
	let latinLine = 0;
	let hasLatin = false;
	for (let match = candidates.exec(text); match; match = candidates.exec(text)) {
		signal?.throwIfAborted();
		while (nextSeparator && nextSeparator.index < match.index) {
			lineStart = nextSeparator.index + nextSeparator[0].length;
			lineNumber += 1;
			nextSeparator = separators.exec(text);
		}
		const character = match[0];
		const codePoint = character.codePointAt(0)!;
		let kind: UnicodeHighlightKind | undefined;
		if (isBidiControl(codePoint)) kind = 'bidi';
		else if (isInvisible(codePoint)) kind = 'invisible';
		else {
			if (latinLine !== lineNumber) {
				latinLine = lineNumber;
				hasLatin = /[A-Za-z]/u.test(text.slice(lineStart, nextSeparator?.index ?? text.length));
			}
			if (hasLatin) kind = 'confusable';
		}
		if (kind) {
			const column = match.index - lineStart + 1;
			result.push(
				Object.freeze({
					range: Range.fromPositions(
						new Position(lineNumber, column),
						new Position(lineNumber, column + character.length),
					),
					kind,
					character,
				}),
			);
		}
	}
	return Object.freeze(result);
}

function isBidiControl(codePoint: number): boolean {
	return (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function isInvisible(codePoint: number): boolean {
	return (
		codePoint === 0x00ad ||
		codePoint === 0x061c ||
		codePoint === 0x200b ||
		codePoint === 0x200c ||
		codePoint === 0x200d ||
		codePoint === 0x2060 ||
		codePoint === 0xfeff ||
		(codePoint >= 0 && codePoint < 0x20 && codePoint !== 0x09)
	);
}
