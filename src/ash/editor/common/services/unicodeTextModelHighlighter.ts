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
	const result: UnicodeHighlight[] = [];
	const lines = snapshot.getText().split(/\r\n|\r|\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		signal?.throwIfAborted();
		const line = lines[lineIndex]!;
		let columnIndex = 0;
		for (const character of line) {
			const endColumnIndex = columnIndex + character.length;
			const kind = classifyCharacter(character, line);
			if (kind) {
				result.push(Object.freeze({
					range: Range.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1), new Position((lineIndex) + 1, (endColumnIndex) + 1)),
					kind,
					character,
				}));
			}
			columnIndex = endColumnIndex;
		}
	}
	return Object.freeze(result);
}

function classifyCharacter(character: string, line: string): UnicodeHighlightKind | undefined {
	const codePoint = character.codePointAt(0)!;
	if (isBidiControl(codePoint)) return 'bidi';
	if (isInvisible(codePoint)) return 'invisible';
	if (isConfusable(character, line)) return 'confusable';
	return undefined;
}

function isBidiControl(codePoint: number): boolean {
	return (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function isInvisible(codePoint: number): boolean {
	return codePoint === 0x00ad
		|| codePoint === 0x061c
		|| codePoint === 0x200b
		|| codePoint === 0x200c
		|| codePoint === 0x200d
		|| codePoint === 0x2060
		|| codePoint === 0xfeff
		|| (codePoint >= 0 && codePoint < 0x20 && codePoint !== 0x09);
}

function isConfusable(character: string, line: string): boolean {
	return /[\u0370-\u03ff\u0400-\u04ff]/u.test(character) && /[A-Za-z]/u.test(line) && /[A-Za-z0-9_$]/u.test(line);
}
