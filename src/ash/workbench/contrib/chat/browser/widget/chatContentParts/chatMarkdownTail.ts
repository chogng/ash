import type { Marked, MarkedOptions, TokensList } from '../../../../../../base/common/marked/marked.js';

export type MarkdownTailCheckpoint = {
	readonly offset: number;
	readonly children: number;
	readonly context: string;
} & ({ readonly kind: 'paragraph' | 'table'; } | { readonly kind: 'list'; readonly marker: string; });

const paragraphContext = '`x`';
const paragraphCheckpointScanLimit = 4096;
const listItem = /^([-+*]|\d{1,9}[.)]) [\p{L}\p{N}]/u;
const emptyListItem = /^([-+*]|\d{1,9}[.)])[ \t]*$/u;
const plainInline = /^[^*_`~[\]<>!\\$]*$/u;

/** Discovers a new sibling block without lexing the source before a proven checkpoint. */
export function lexMarkdownTail(
	source: string,
	checkpoint: MarkdownTailCheckpoint,
	lexer: Marked,
	options: Pick<MarkedOptions, 'breaks' | 'gfm'>,
): { tokens: TokensList; prefix: string; contextLength: number; firstBlockEnd: number; } | undefined {
	const { context, offset } = checkpoint;
	const input = context + source.slice(offset);
	const tokens = lexer.lexer(input, options);
	const [first, separator, sibling] = tokens;
	// A loose list changes the markup of earlier items. Require an actual
	// separator and sibling so a continuation cannot be mistaken for a split.
	if (first?.type !== checkpoint.kind || first.type === 'list' && first.loose
		|| separator?.type !== 'space' || !sibling || !first.raw.startsWith(context) || first.raw.length <= context.length
		|| Object.keys(tokens.links).length || tokens.map(token => token.raw).join('') !== input) return undefined;
	return { tokens, prefix: source.slice(0, offset), contextLength: context.length, firstBlockEnd: offset + first.raw.length - context.length };
}

/** Finds a resumable boundary in the source just rendered by Marked. */
export function markdownTailCheckpoint(
	source: string,
	raw: Element,
	lexer: Marked,
	options: Pick<MarkedOptions, 'breaks' | 'gfm'>,
	previous?: MarkdownTailCheckpoint,
): MarkdownTailCheckpoint | undefined {
	switch (raw.tagName) {
		case 'P':
			return paragraphCheckpoint(source, raw, lexer, options, previous);
		case 'UL':
		case 'OL':
			return rowCheckpoint(source, raw, false, previous);
		case 'TABLE':
			return rowCheckpoint(source, raw, true, previous);
		default:
			return undefined;
	}
}

function rowCheckpoint(source: string, raw: Element, table: boolean, previous?: MarkdownTailCheckpoint): MarkdownTailCheckpoint | undefined {
	if (previous && previous.kind !== (table ? 'table' : 'list')) return undefined;
	const firstLine = source.indexOf('\n');
	const headerLength = table && firstLine >= 0 ? source.indexOf('\n', firstLine + 1) + 1 : 0;
	if (table && (!headerLength || !source.startsWith('|'))) return undefined;
	const body = table ? raw.querySelector('tbody') : raw;
	const rows = source.slice(headerLength).split('\n');
	if (rows.at(-1) === '') rows.pop();
	if (!rows.length || body?.children.length !== rows.length || body.childNodes.length !== 2 * rows.length + (table ? 0 : 1)) return undefined;
	const marker = previous?.kind === 'list' ? previous.marker : listMarker(rows[0]);
	if (table) {
		if (rows.some(row => !row.startsWith('|'))) return undefined;
	} else {
		const last = rows.length - 1;
		if (!marker || rows.some((row, index) => index < last && listMarker(row) !== marker)) return undefined;
		// Marked already recognizes a bare marker as an empty item. Keep that
		// item mutable until its text arrives.
		const lastRow = rows[last];
		if (listMarker(lastRow) !== marker
			&& (emptyListItem.exec(lastRow)?.[1].slice(-1) !== marker || !body.lastElementChild?.matches('li:empty'))) return undefined;
	}

	// The last row is mutable. A later chunk can still grow it or turn the
	// following line into a continuation, in which case we reparse the block.
	const end = source.length - (source.endsWith('\n') ? 1 : 0);
	const offset = end - rows.at(-1)!.length;
	const boundary = {
		offset: offset + (previous ? previous.offset - previous.context.length : 0),
		children: (previous?.children ?? 0) + 2 * (rows.length - 1),
		context: source.slice(0, headerLength),
	};
	return table ? { ...boundary, kind: 'table' } : { ...boundary, kind: 'list', marker };
}

function listMarker(line: string): string {
	return listItem.exec(line)?.[1].slice(-1) ?? '';
}

function paragraphCheckpoint(
	source: string,
	raw: Element,
	lexer: Marked,
	options: Pick<MarkedOptions, 'breaks' | 'gfm'>,
	previous?: MarkdownTailCheckpoint,
): MarkdownTailCheckpoint | undefined {
	if (source.includes('\n') || previous && (previous.kind !== 'paragraph' || raw.firstChild?.nodeName !== 'CODE')) return undefined;
	const code = [...raw.children].filter(element => element.tagName === 'CODE');
	if (code.length <= (previous ? 1 : 0)) return previous;
	// Searching for a checkpoint is optional. Bound the extra lexer pass even
	// when a full fallback render contains a long, uncheckpointable paragraph.
	const prefix = source.slice(0, paragraphCheckpointScanLimit);
	const tokens = lexer.lexer(prefix, options);
	const paragraph = tokens[0];
	if (tokens.length !== 1 || paragraph?.type !== 'paragraph' || paragraph.raw !== prefix || !paragraph.tokens) return previous;
	let offset = 0;
	let codeIndex = 0;
	let boundary: { readonly offset: number; readonly node: Element; } | undefined;
	for (const token of paragraph.tokens) {
		const start = offset;
		offset += token.raw.length;
		const spaceBefore = source[start - 1] === ' ';
		const spaceAfter = source[offset] === ' ';
		switch (token.type) {
			case 'text':
				if (plainInline.test(token.raw)) continue;
				break;
			case 'strong':
				if (spaceBefore && spaceAfter && token.raw === `**${token.text}**` && plainInline.test(token.text)) continue;
				break;
			case 'link':
				if (spaceBefore && spaceAfter && /^https?:\/\/[\w./%+-]+$/u.test(token.href)
					&& plainInline.test(token.text) && token.raw === `[${token.text}](${token.href})`) continue;
				break;
			case 'codespan': {
				const node = code[codeIndex++];
				if (node?.textContent !== token.text || !/^`[^`]+`$/u.test(token.raw)) break;
				if (offset < prefix.length && spaceBefore && (spaceAfter || prefix.startsWith('. ', offset))) boundary = { offset, node };
				continue;
			}
		}
		// Literal or unmatched syntax can bind to future text. Only use a
		// checkpoint reached before it, where the inline tokens are closed.
		break;
	}
	if (!boundary) return previous;

	// A synthetic code span gives the suffix the same left boundary without
	// copying the already rendered prefix. It is removed before DOM patching.
	const contextLength = previous?.context.length ?? 0;
	const contextChildren = previous ? 1 : 0;
	return {
		kind: 'paragraph',
		context: paragraphContext,
		offset: (previous?.offset ?? 0) + boundary.offset - contextLength,
		children: (previous?.children ?? 0) + [...raw.childNodes].indexOf(boundary.node) + 1 - contextChildren,
	};
}
