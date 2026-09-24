import { ScanError, SyntaxKind, createScanner } from './json.js';

export interface FormattingOptions {
	readonly tabSize?: number;
	readonly insertSpaces?: boolean;
	readonly eol?: string;
}

export interface Edit {
	readonly offset: number;
	readonly length: number;
	readonly content: string;
}

export interface Range {
	readonly offset: number;
	readonly length: number;
}

export function format(documentText: string, range: Range | undefined, options: FormattingOptions = {}): readonly Edit[] {
	if (typeof documentText !== 'string') throw new TypeError('JSON document must be text');
	const tabSize = options.tabSize ?? 4;
	if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('JSON formatting tab size must be positive');
	const insertSpaces = options.insertSpaces ?? false;
	let initialIndentLevel: number;
	let formatText: string;
	let formatTextStart: number;
	let rangeStart: number;
	let rangeEnd: number;
	if (range) {
		rangeStart = Math.max(0, Math.min(documentText.length, range.offset));
		rangeEnd = Math.max(rangeStart, Math.min(documentText.length, range.offset + range.length));
		formatTextStart = rangeStart;
		while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) formatTextStart -= 1;
		let endOffset = rangeEnd;
		while (endOffset < documentText.length && !isEOL(documentText, endOffset)) endOffset += 1;
		formatText = documentText.substring(formatTextStart, endOffset);
		initialIndentLevel = computeIndentLevel(formatText, tabSize);
	} else {
		formatText = documentText;
		initialIndentLevel = 0;
		formatTextStart = 0;
		rangeStart = 0;
		rangeEnd = documentText.length;
	}
	const eol = getEOL(options, documentText);
	const indentValue = insertSpaces ? ' '.repeat(tabSize) : '\t';
	const scanner = createScanner(formatText, false);
	let lineBreak = false;
	let indentLevel = 0;
	let hasError = false;
	const editOperations: Edit[] = [];

	const newLineAndIndent = (): string => `${eol}${indentValue.repeat(Math.max(0, initialIndentLevel + indentLevel))}`;
	const scanNext = (): SyntaxKind => {
		let token = scanner.scan();
		lineBreak = false;
		while (token === SyntaxKind.Trivia || token === SyntaxKind.LineBreakTrivia) {
			lineBreak = lineBreak || token === SyntaxKind.LineBreakTrivia;
			token = scanner.scan();
		}
		hasError = token === SyntaxKind.Unknown || scanner.getTokenError() !== ScanError.None;
		return token;
	};
	const addEdit = (content: string, startOffset: number, endOffset: number): void => {
		if (!hasError && startOffset < rangeEnd && endOffset > rangeStart && documentText.substring(startOffset, endOffset) !== content) {
			editOperations.push(Object.freeze({ offset: startOffset, length: endOffset - startOffset, content }));
		}
	};

	let firstToken = scanNext();
	if (firstToken !== SyntaxKind.EOF) {
		addEdit(indentValue.repeat(initialIndentLevel), formatTextStart, scanner.getTokenOffset() + formatTextStart);
	}
	while (firstToken !== SyntaxKind.EOF) {
		let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
		let secondToken = scanNext();
		let replaceContent = '';
		while (!lineBreak && (secondToken === SyntaxKind.LineCommentTrivia || secondToken === SyntaxKind.BlockCommentTrivia)) {
			const commentTokenStart = scanner.getTokenOffset() + formatTextStart;
			addEdit(' ', firstTokenEnd, commentTokenStart);
			firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
			replaceContent = secondToken === SyntaxKind.LineCommentTrivia ? newLineAndIndent() : '';
			secondToken = scanNext();
		}
		if (secondToken === SyntaxKind.CloseBraceToken) {
			if (firstToken !== SyntaxKind.OpenBraceToken) {
				indentLevel -= 1;
				replaceContent = newLineAndIndent();
			}
		} else if (secondToken === SyntaxKind.CloseBracketToken) {
			if (firstToken !== SyntaxKind.OpenBracketToken) {
				indentLevel -= 1;
				replaceContent = newLineAndIndent();
			}
		} else {
			switch (firstToken) {
				case SyntaxKind.OpenBracketToken:
				case SyntaxKind.OpenBraceToken:
					indentLevel += 1;
					replaceContent = newLineAndIndent();
					break;
				case SyntaxKind.CommaToken:
				case SyntaxKind.LineCommentTrivia:
					replaceContent = newLineAndIndent();
					break;
				case SyntaxKind.BlockCommentTrivia:
					replaceContent = lineBreak ? newLineAndIndent() : ' ';
					break;
				case SyntaxKind.ColonToken:
					replaceContent = ' ';
					break;
				case SyntaxKind.StringLiteral:
					if (secondToken === SyntaxKind.ColonToken) break;
				case SyntaxKind.NullKeyword:
				case SyntaxKind.TrueKeyword:
				case SyntaxKind.FalseKeyword:
				case SyntaxKind.NumericLiteral:
				case SyntaxKind.CloseBraceToken:
				case SyntaxKind.CloseBracketToken:
					if (secondToken === SyntaxKind.LineCommentTrivia || secondToken === SyntaxKind.BlockCommentTrivia) replaceContent = ' ';
					else if (secondToken !== SyntaxKind.CommaToken && secondToken !== SyntaxKind.EOF) hasError = true;
					break;
				case SyntaxKind.Unknown:
					hasError = true;
					break;
			}
			if (lineBreak && (secondToken === SyntaxKind.LineCommentTrivia || secondToken === SyntaxKind.BlockCommentTrivia)) {
				replaceContent = newLineAndIndent();
			}
		}
		const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
		addEdit(replaceContent, firstTokenEnd, secondTokenStart);
		firstToken = secondToken;
	}
	return Object.freeze(editOperations);
}

export function toFormattedString(value: unknown, options: FormattingOptions = {}): string {
	const content = JSON.stringify(value, undefined, options.insertSpaces ? options.tabSize ?? 4 : '\t');
	if (content === undefined) throw new TypeError('JSON value must be serializable');
	return options.eol === undefined ? content : content.replace(/\r\n|\r|\n/gu, options.eol);
}

export function getEOL(options: FormattingOptions, text: string): string {
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === '\r') return text[index + 1] === '\n' ? '\r\n' : '\r';
		if (text[index] === '\n') return '\n';
	}
	return options.eol ?? '\n';
}

export function isEOL(text: string, offset: number): boolean {
	return text[offset] === '\r' || text[offset] === '\n';
}

function computeIndentLevel(content: string, tabSize: number): number {
	let columns = 0;
	for (const character of content) {
		if (character === ' ') columns += 1;
		else if (character === '\t') columns += tabSize;
		else break;
	}
	return Math.floor(columns / tabSize);
}
