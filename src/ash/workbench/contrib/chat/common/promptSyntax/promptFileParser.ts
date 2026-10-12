import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { localize } from '../../../../../nls.js';
import { marked, type Token } from '../../../../../base/common/marked/marked.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';

/** Keeps the exact document and separates its Markdown body for readonly snapshot consumers. */
export class ParsedPromptFile {
	constructor(
		public readonly uri: URI,
		public readonly content: string,
		public readonly header?: PromptHeader,
		public readonly body?: PromptBody,
	) { }
}

export interface ParseError {
	readonly message: string;
	readonly range: Range;
	readonly code: string;
}

export interface IHeaderAttribute {
	readonly range: Range;
	readonly key: string;
	readonly value: IValue;
}

export interface IScalarValue {
	readonly type: 'scalar';
	readonly value: string;
	readonly range: Range;
	readonly format: 'single' | 'double' | 'none' | 'literal' | 'folded';
}

export interface ISequenceValue {
	readonly type: 'sequence';
	readonly items: readonly IValue[];
	readonly range: Range;
}

export interface IMapValue {
	readonly type: 'map';
	readonly properties: readonly { readonly key: IScalarValue; readonly value: IValue; }[];
	readonly range: Range;
}

export type IValue = IScalarValue | ISequenceValue | IMapValue;

/** Syntax coordinates and values only; the Rust catalog owns Skill acceptance and permissions. */
export class PromptHeader {
	constructor(
		public readonly range: Range,
		public readonly uri: URI,
		public readonly attributes: readonly IHeaderAttribute[],
		public readonly errors: readonly ParseError[],
	) { }

	public getAttribute(key: string): IHeaderAttribute | undefined {
		return this.attributes.find(attribute => attribute.key === key);
	}
}

/** Keeps body offsets in the exact source while exposing editor line/column coordinates. */
export interface IBodyFileReference {
	readonly content: string;
	readonly range: Range;
	readonly isMarkdownLink: boolean;
}

export class PromptBody {
	private references: readonly IBodyFileReference[] | undefined;
	constructor(
		public readonly range: Range,
		private readonly source: string,
		public readonly uri: URI,
		public readonly offset: number,
	) { }

	public getContent(): string {
		return this.source.slice(this.offset);
	}

	public get fileReferences(): readonly IBodyFileReference[] {
		return this.references ??= bodyFileReferences(this.getContent(), this.range.startLineNumber);
	}

	public resolveFilePath(path: string, userHome?: URI): URI | undefined {
		if (!path || path.startsWith('#') || path.includes('\0')) return undefined;
		if (path.startsWith('~/')) return userHome ? URI.joinPath(userHome, path.slice(2)) : undefined;
		try {
			const hasScheme = /^[a-z][a-z\d+.-]*:/iu.test(path);
			const target = URI.parse(hasScheme ? path : `relative:${path}`, true);
			if (hasScheme) return target.scheme === 'file' || target.scheme === this.uri.scheme ? target : undefined;
			return URI.joinPath(this.uri.with({ fragment: '' }), '..', target.path).with({ fragment: target.fragment });
		} catch { return undefined; }
	}

}

export class PromptFileParser {
	public parse(uri: URI, content: string): ParsedPromptFile {
		const lines = content.split(/(\r\n|\n|\r)/u);
		let bodyOffset = 0;
		let bodyLine = 1;
		let headerRange: Range | undefined;
		let headerEnd = content.length;
		let headerClosed = false;
		if (lines[0] === '---') {
			headerRange = new Range(Math.min(2, Math.floor(lines.length / 2) + 1), 1, Math.floor(lines.length / 2) + 1, lines.at(-1)!.length + 1);
			let offset = lines[0].length + (lines[1]?.length ?? 0);
			for (let index = 2; index < lines.length; index += 2) {
				offset += lines[index]!.length + (lines[index + 1]?.length ?? 0);
				if (lines[index] === '---') {
					bodyOffset = offset;
					bodyLine = index / 2 + 2;
					headerRange = new Range(2, 1, index / 2 + 1, 1);
					headerEnd = offset - lines[index]!.length - (lines[index + 1]?.length ?? 0);
					headerClosed = true;
					break;
				}
			}
		}
		const header = headerRange ? parseHeader(uri, content, lines[0]!.length + (lines[1]?.length ?? 0), headerEnd, headerRange, headerClosed) : undefined;
		const body = bodyOffset < content.length
			? new PromptBody(new Range(bodyLine, 1, Math.floor(lines.length / 2) + 1, lines.at(-1)!.length + 1), content, uri, bodyOffset)
			: undefined;
		return new ParsedPromptFile(uri, content, header, body);
	}
}

/** Converts the library AST without resolving aliases, tags or arbitrary JavaScript objects. */
function parseHeader(uri: URI, source: string, offset: number, end: number, range: Range, closed: boolean): PromptHeader {
	const attributes: IHeaderAttribute[] = [];
	const errors: ParseError[] = [];
	const starts = [0];
	for (const match of source.matchAll(/\r\n|\n|\r/gu)) starts.push(match.index + match[0].length);
	const position = (index: number) => {
		index = Math.max(0, Math.min(source.length, index));
		let low = 0;
		let high = starts.length;
		while (low + 1 < high) {
			const middle = Math.floor((low + high) / 2);
			if (starts[middle]! <= index) low = middle; else high = middle;
		}
		return { line: low + 1, column: index - starts[low]! + 1 };
	};
	const at = (start: number, finish: number): Range => {
		const first = position(offset + start);
		const last = position(offset + Math.max(start, finish));
		return new Range(first.line, first.column, last.line, last.column);
	};
	if (!closed) errors.push({ code: 'unclosedHeader', range: new Range(1, 1, 1, 4), message: localize('prompt.syntax.unclosed', 'Close the Skill header with a line containing --- before the Markdown body.') });
	const text = source.slice(offset, end);
	if (new TextEncoder().encode(text).length > 16 * 1024) {
		errors.push({ code: 'headerTooLarge', range, message: localize('prompt.syntax.tooLarge', 'The Skill header exceeds 16 KiB. Move instructions into the Markdown body.') });
		return new PromptHeader(range, uri, attributes, errors);
	}
	const convert = (node: Node | null | undefined, depth: number): IValue => {
		const nodeRange = at(node?.range?.[0] ?? 0, node?.range?.[1] ?? 0);
		if (depth > 16 || isAlias(node) || node?.tag || (node && 'anchor' in node && node.anchor)) {
			errors.push({ code: 'unsupportedYaml', range: nodeRange, message: localize('prompt.syntax.unsupported', 'Skill headers do not support YAML aliases, anchors, tags or deeply nested values.') });
			return { type: 'scalar', value: '', format: 'none', range: nodeRange };
		}
		if (isMap(node)) return {
			type: 'map', range: nodeRange, properties: node.items.flatMap(pair => {
				const key = convert(isNode(pair.key) ? pair.key : undefined, depth + 1);
				return key.type === 'scalar' ? [{ key, value: convert(isNode(pair.value) ? pair.value : undefined, depth + 1) }] : [];
			})
		};
		if (isSeq(node)) return { type: 'sequence', range: nodeRange, items: node.items.map(item => convert(isNode(item) ? item : undefined, depth + 1)) };
		const format = isScalar(node) ? ({ QUOTE_SINGLE: 'single', QUOTE_DOUBLE: 'double', BLOCK_LITERAL: 'literal', BLOCK_FOLDED: 'folded', PLAIN: 'none' } as const)[node.type ?? 'PLAIN'] : 'none';
		return { type: 'scalar', value: isScalar(node) ? String(node.value ?? '') : '', format, range: nodeRange };
	};
	try {
		const document = parseDocument(text, { schema: 'failsafe', prettyErrors: false, stringKeys: true });
		for (const error of [...document.errors, ...document.warnings]) {
			errors.push({ code: error.code, range: at(error.pos[0], error.pos[1]), message: localize('prompt.syntax.invalidYaml', 'Invalid YAML in the Skill header ({0}).', error.code) });
		}
		const root = convert(document.contents, 0);
		if (root.type === 'map') {
			for (const property of root.properties) attributes.push({ key: property.key.value, range: Range.fromPositions(property.key.range.getStartPosition(), property.value.range.getEndPosition()), value: property.value });
		} else if (text.trim()) {
			errors.push({ code: 'expectedMapping', range: root.range, message: localize('prompt.syntax.mapping', 'A Skill header must be a mapping of field names to values.') });
		}
	} catch {
		errors.push({ code: 'invalidYaml', range, message: localize('prompt.syntax.parseFailed', 'The Skill header could not be parsed as YAML.') });
	}
	return new PromptHeader(range, uri, attributes, errors);
}


/** Marked owns Markdown grammar. Source searches only recover ranges for its recognized tokens. */
function bodyFileReferences(body: string, startLine: number): readonly IBodyFileReference[] {
	const source = body.replace(/\r\n|\r/gu, '\n');
	const result: IBodyFileReference[] = [];
	const starts = [0];
	for (const match of source.matchAll(/\n/gu)) starts.push(match.index + 1);
	const at = (offset: number, length: number): Range => {
		const lineAt = (value: number): number => {
			let low = 0;
			let high = starts.length;
			while (low + 1 < high) {
				const middle = Math.floor((low + high) / 2);
				if (starts[middle]! <= value) low = middle; else high = middle;
			}
			return low;
		};
		const index = lineAt(offset);
		const end = lineAt(offset + length);
		return new Range(startLine + index, offset - starts[index]! + 1, startLine + end, offset + length - starts[end]! + 1);
	};
	const add = (content: string, offset: number, length: number, isMarkdownLink: boolean) => {
		if (content.startsWith('#') || /^[a-z][a-z\d+.-]*:/iu.test(content) && !content.startsWith('file:')) return;
		result.push({ content, range: at(offset, length), isMarkdownLink });
	};
	const walk = (tokens: readonly Token[], start: number, end: number): void => {
		let cursor = start;
		for (const token of tokens) {
			const found = source.indexOf(token.raw, cursor);
			const offset = found >= 0 && found < end ? found : cursor;
			const limit = found >= 0 && found < end ? Math.min(end, offset + token.raw.length) : end;
			if (token.type === 'code' || token.type === 'codespan' || token.type === 'html' || token.type === 'image') { cursor = limit; continue; }
			if (token.type === 'link' || token.type === 'def') {
				const content = token.href as string;
				const target = token.raw.indexOf(content, token.type === 'link' ? token.raw.indexOf('](') + 2 : 0);
				add(content, target < 0 ? offset : offset + target, target < 0 ? token.raw.length : content.length, true);
			} else if ('tokens' in token && Array.isArray(token.tokens)) {
				walk(token.tokens, offset, limit);
			} else if (token.type === 'list') {
				walk(token.items, offset, limit);
			} else if (token.type === 'text') {
				for (const match of token.raw.matchAll(/#file:([^\s`<>]+)|#file:<([^>]+)>/gu)) {
					const content = (match[1] ?? match[2]!).replace(/[),.;]+$/u, '');
					add(content, offset + match.index + '#file:'.length + (match[2] ? 1 : 0), content.length, false);
				}
			}
			cursor = limit;
		}
	};
	walk(marked.lexer(source), 0, source.length);
	return result.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
}
