import { parseJsonDocument } from './json.js';
import { SyntaxKind, createScanner } from './json.js';

/** Parses JSON with line comments, block comments, and trailing commas. */
export function parseJsonc(source: string, owner = 'JSONC source'): unknown {
	if (typeof source !== 'string') throw new TypeError(`${owner} must be text`);
	const document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
	const error = document.errors[0];
	if (error) throw new TypeError(`${owner} is not valid JSONC at offset ${error.offset}: ${error.message}`);
	return document.value;
}

export function stripComments(content: string): string {
	if (typeof content !== 'string') throw new TypeError('JSONC source must be text');
	const scanner = createScanner(content);
	const tokens: Array<{ readonly kind: SyntaxKind; readonly offset: number; readonly length: number }> = [];
	while (scanner.scan() !== SyntaxKind.EOF) {
		tokens.push({ kind: scanner.getToken(), offset: scanner.getTokenOffset(), length: scanner.getTokenLength() });
	}
	const removals: Array<{ readonly offset: number; readonly length: number; readonly replacement: string }> = [];
	for (const token of tokens) {
		if (token.kind !== SyntaxKind.LineCommentTrivia && token.kind !== SyntaxKind.BlockCommentTrivia) continue;
		const raw = content.slice(token.offset, token.offset + token.length);
		const replacement = token.kind === SyntaxKind.LineCommentTrivia
			? raw.replace(/[^\r\n]/gu, '')
			: raw.replace(/[^\r\n]/gu, ' ');
		removals.push({ offset: token.offset, length: token.length, replacement });
	}
	for (let index = 0; index < tokens.length; index += 1) {
		if (tokens[index]!.kind !== SyntaxKind.CommaToken) continue;
		let next = index + 1;
		while (next < tokens.length && isTrivia(tokens[next]!.kind)) next += 1;
		if (next < tokens.length && (tokens[next]!.kind === SyntaxKind.CloseBraceToken || tokens[next]!.kind === SyntaxKind.CloseBracketToken)) {
			removals.push({ offset: tokens[index]!.offset, length: 1, replacement: '' });
		}
	}
	return removals.sort((left, right) => right.offset - left.offset).reduce(
		(source, removal) => `${source.slice(0, removal.offset)}${removal.replacement}${source.slice(removal.offset + removal.length)}`,
		content,
	);
}

export function parse<T>(content: string): T {
	return parseJsonc(content, 'JSONC source') as T;
}

function isTrivia(kind: SyntaxKind): boolean {
	return kind === SyntaxKind.Trivia || kind === SyntaxKind.LineBreakTrivia || kind === SyntaxKind.LineCommentTrivia ||
		kind === SyntaxKind.BlockCommentTrivia;
}
