import { CharCode } from './charCode.js';

/** Encodes a literal value for use in an HTML attribute. */
export function htmlAttributeEncodeValue(value: string): string {
	return value.replace(/[<>"'&]/g, ch => {
		switch (ch) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case '\'': return '&apos;';
			case '&': return '&amp;';
		}
		return ch;
	});
}

/** Produces `a`-`z`, then `A`-`Z`, and repeats. */
export function singleLetterHash(n: number): string {
	const letterCount = CharCode.Z - CharCode.A + 1;
	n %= 2 * letterCount;
	return n < letterCount
		? String.fromCharCode(CharCode.a + n)
		: String.fromCharCode(CharCode.A + n - letterCount);
}

/** Escapes every regular-expression metacharacter in a literal string. */
export function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

export function convertSimple2RegExpPattern(pattern: string): string {
	return pattern.replace(/[\-\\\{\}\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&').replace(/[\*]/g, '.*');
}

export interface RegExpOptions {
	matchCase?: boolean;
	wholeWord?: boolean;
	multiline?: boolean;
	global?: boolean;
	unicode?: boolean;
}

export function createRegExp(searchString: string, isRegex: boolean, options: RegExpOptions = {}): RegExp {
	if (!searchString) throw new Error('Cannot create regex from empty string');
	if (!isRegex) searchString = escapeRegExpCharacters(searchString);
	if (options.wholeWord) {
		if (!/\B/.test(searchString.charAt(0))) searchString = '\\b' + searchString;
		if (!/\B/.test(searchString.charAt(searchString.length - 1))) searchString += '\\b';
	}
	let modifiers = '';
	if (options.global) modifiers += 'g';
	if (!options.matchCase) modifiers += 'i';
	if (options.multiline) modifiers += 'm';
	if (options.unicode) modifiers += 'u';
	return new RegExp(searchString, modifiers);
}

/** Returns the number of equal UTF-16 code units at the beginning of two strings. */
export function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
	return index;
}

/** Returns the number of equal UTF-16 code units at the end of two strings. */
export function commonSuffixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let length = 0;
	while (
		length < limit &&
		left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)
	) {
		length += 1;
	}
	return length;
}

export function isHighSurrogate(charCode: number): boolean {
	return charCode >= 0xD800 && charCode <= 0xDBFF;
}

export function isLowSurrogate(charCode: number): boolean {
	return charCode >= 0xDC00 && charCode <= 0xDFFF;
}

export function computeCodePoint(highSurrogate: number, lowSurrogate: number): number {
	return ((highSurrogate - 0xD800) << 10) + (lowSurrogate - 0xDC00) + 0x10000;
}

export function getNextCodePoint(value: string, length: number, offset: number): number {
	const charCode = value.charCodeAt(offset);
	if (isHighSurrogate(charCode) && offset + 1 < length) {
		const nextCharCode = value.charCodeAt(offset + 1);
		if (isLowSurrogate(nextCharCode)) return computeCodePoint(charCode, nextCharCode);
	}
	return charCode;
}

function getPrevCodePoint(value: string, offset: number): number {
	const charCode = value.charCodeAt(offset - 1);
	if (isLowSurrogate(charCode) && offset > 1) {
		const previousCharCode = value.charCodeAt(offset - 2);
		if (isHighSurrogate(previousCharCode)) return computeCodePoint(previousCharCode, charCode);
	}
	return charCode;
}

export class CodePointIterator {
	private offsetValue: number;

	constructor(private readonly value: string, offset = 0) {
		this.offsetValue = offset;
	}

	get offset(): number { return this.offsetValue; }
	setOffset(offset: number): void { this.offsetValue = offset; }
	prevCodePoint(): number {
		const codePoint = getPrevCodePoint(this.value, this.offsetValue);
		this.offsetValue -= codePoint >= 0x10000 ? 2 : 1;
		return codePoint;
	}
	nextCodePoint(): number {
		const codePoint = getNextCodePoint(this.value, this.value.length, this.offsetValue);
		this.offsetValue += codePoint >= 0x10000 ? 2 : 1;
		return codePoint;
	}
	eol(): boolean { return this.offsetValue >= this.value.length; }
}

export function isFullWidthCharacter(charCode: number): boolean {
	return (charCode >= 0x2E80 && charCode <= 0xD7AF)
		|| (charCode >= 0xF900 && charCode <= 0xFAFF)
		|| (charCode >= 0xFF01 && charCode <= 0xFF5E)
		|| (charCode >= 0xFFE0 && charCode <= 0xFFE6);
}

export function isEmojiImprecise(value: number): boolean {
	return (value >= 0x1F1E6 && value <= 0x1F1FF) || value === 8986 || value === 8987 || value === 9200
		|| value === 9203 || (value >= 9728 && value <= 10175) || value === 11088 || value === 11093
		|| (value >= 127744 && value <= 128591) || (value >= 128640 && value <= 128764)
		|| (value >= 128992 && value <= 129008) || (value >= 129280 && value <= 129535)
		|| (value >= 129648 && value <= 129782);
}

export function containsRTL(value: string): boolean {
	return /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/u.test(value);
}

export function isBasicASCII(value: string): boolean {
	return /^[\t\n\r\x20-\x7E]*$/u.test(value);
}

export function splitLines(value: string): string[] {
	return value.split(/\r\n|\r|\n/u);
}

export function firstNonWhitespaceIndex(value: string): number {
	for (let index = 0; index < value.length; index++) {
		const characterCode = value.charCodeAt(index);
		if (characterCode !== 32 && characterCode !== 9) return index;
	}
	return -1;
}

/** Returns the leading spaces and tabs in the selected string interval. */
export function getLeadingWhitespace(value: string, start = 0, end = value.length): string {
	for (let index = start; index < end; index++) {
		const characterCode = value.charCodeAt(index);
		if (characterCode !== CharCode.Space && characterCode !== CharCode.Tab) return value.substring(start, index);
	}
	return value.substring(start, end);
}

export function lastNonWhitespaceIndex(value: string, startIndex = value.length - 1): number {
	for (let index = startIndex; index >= 0; index--) {
		const characterCode = value.charCodeAt(index);
		if (characterCode !== 32 && characterCode !== 9) return index;
	}
	return -1;
}

export function isAsciiDigit(characterCode: number): boolean {
	return characterCode >= 48 && characterCode <= 57;
}

export function isLowerAsciiLetter(characterCode: number): boolean {
	return characterCode >= 97 && characterCode <= 122;
}

export function isUpperAsciiLetter(characterCode: number): boolean {
	return characterCode >= 65 && characterCode <= 90;
}

export class GraphemeIterator {
	private readonly boundaries: readonly number[];
	private boundaryIndex: number;

	constructor(value: string, offset = 0) {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
			throw new RangeError('Grapheme iterator offset is outside the string');
		}
		this.boundaries = graphemeBoundaries(value);
		this.boundaryIndex = this.boundaries.indexOf(offset);
		if (this.boundaryIndex < 0) {
			throw new RangeError('Grapheme iterator offset splits a grapheme');
		}
	}

	public get offset(): number {
		return this.boundaries[this.boundaryIndex];
	}

	public nextGraphemeLength(): number {
		if (this.eol()) {
			return 0;
		}
		const start = this.offset;
		this.boundaryIndex++;
		return this.offset - start;
	}

	public prevGraphemeLength(): number {
		if (this.boundaryIndex === 0) {
			return 0;
		}
		const end = this.offset;
		this.boundaryIndex--;
		return end - this.offset;
	}

	public eol(): boolean {
		return this.boundaryIndex === this.boundaries.length - 1;
	}
}

export function nextCharLength(value: string, initialOffset: number): number {
	return new GraphemeIterator(value, initialOffset).nextGraphemeLength();
}

export function prevCharLength(value: string, initialOffset: number): number {
	return new GraphemeIterator(value, initialOffset).prevGraphemeLength();
}

/** Returns the offset reached by deleting the preceding complete grapheme. */
export function getLeftDeleteOffset(offset: number, value: string): number {
	return offset - prevCharLength(value, offset);
}

/** Returns the UTF-16 boundaries of the grapheme containing one offset. */
export function getCharContainingOffset(value: string, offset: number): readonly [number, number] {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
		throw new RangeError('Grapheme offset is outside the string');
	}
	const boundaries = graphemeBoundaries(value);
	for (let boundaryIndex = 1; boundaryIndex < boundaries.length; boundaryIndex += 1) {
		const endOffset = boundaries[boundaryIndex]!;
		if (offset < endOffset) return [boundaries[boundaryIndex - 1]!, endOffset];
	}
	return [value.length, value.length];
}

export function regExpLeadsToEndlessLoop(regexp: RegExp): boolean {
	if (regexp.source === '^' || regexp.source === '^$' || regexp.source === '$' || regexp.source === '^\\s*$') return false;
	const match = regexp.exec('');
	return Boolean(match && regexp.lastIndex === 0);
}

function graphemeBoundaries(value: string): readonly number[] {
	const boundaries = [0];
	for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
		const end = segment.index + segment.segment.length;
		if (end > boundaries.at(-1)!) {
			boundaries.push(end);
		}
	}
	if (boundaries.at(-1) !== value.length) {
		boundaries.push(value.length);
	}
	return Object.freeze(boundaries);
}
