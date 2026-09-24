import { CharCode } from "../../../../base/common/charCode.js";

export enum StringEOL {
	Unknown = 0,
	Invalid = 3,
	LF = 1,
	CRLF = 2,
}

export function countEOL(text: string): [number, number, number, StringEOL] {
	let count = 0;
	let firstLineLength = 0;
	let lastLineStart = 0;
	let eol = StringEOL.Unknown;
	for (let index = 0; index < text.length; index += 1) {
		const character = text.charCodeAt(index);
		if (character === CharCode.CarriageReturn) {
			if (count === 0) firstLineLength = index;
			count += 1;
			if (text.charCodeAt(index + 1) === CharCode.LineFeed) { eol |= StringEOL.CRLF; index += 1; }
			else eol |= StringEOL.Invalid;
			lastLineStart = index + 1;
		} else if (character === CharCode.LineFeed) {
			if (count === 0) firstLineLength = index;
			count += 1;
			eol |= StringEOL.LF;
			lastLineStart = index + 1;
		}
	}
	if (count === 0) firstLineLength = text.length;
	return [count, firstLineLength, text.length - lastLineStart, eol];
}
