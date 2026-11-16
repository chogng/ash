import type { ArkdownEdit, ArkdownNode, ArkdownRange, ArkdownTextColor } from './arkdownRuntime.js';

export type ArkdownInlineFormat =
	| { readonly kind: 'underline' | 'highlight'; readonly active: boolean; }
	| { readonly kind: 'text_color'; readonly color: ArkdownTextColor | undefined; };

export type ArkdownTableCellFormat = ArkdownInlineFormat
	| { readonly kind: 'strong' | 'emphasis' | 'strikethrough' | 'code'; readonly active: boolean; };

/** A rectangle formats its real owner cells independently. Cell padding and all
 * table syntax stay outside the edits; missing cells remain source-free. The
 * caller commits these edits together through the owning text model. */
export function formatArkdownTableCells(source: string, cells: readonly ArkdownNode[], format: ArkdownTableCellFormat): readonly ArkdownEdit[] {
	const edits: ArkdownEdit[] = [];
	for (const cell of cells) {
		if (cell.tableCellMissing || !cell.children.length) continue;
		const nodes = tableSourceNodes(source, cell.children, cell.range.start);
		if (format.kind === 'underline' || format.kind === 'highlight' || format.kind === 'text_color') {
			const edit = formatArkdownInline(source, nodes, cell.range, format);
			if (edit) edits.push({ range: edit.range, text: edit.text });
			continue;
		}
		let marked = false, unmarked = false;
		const inspect = (node: ArkdownNode, active: boolean): void => {
			if (node.kind === 'image') return;
			active ||= node.kind === format.kind;
			if (node.children.length) for (const child of node.children) inspect(child, active);
			else if (node.text) { if (active) marked = true; else unmarked = true; }
		};
		for (const child of nodes) inspect(child, false);
		if (format.active ? !unmarked : !marked) continue;
		const range = { start: nodes[0].range.start, end: nodes.at(-1)!.range.end };
		const text = tableInlineSource(source, nodes, { kind: format.kind, active: format.active });
		if (text !== source.slice(range.start, range.end)) edits.push({ range, text });
	}
	return edits;
}

function tableSourceNodes(source: string, nodes: readonly ArkdownNode[], start: number): readonly ArkdownNode[] {
	return nodes.map(node => {
		// pulldown's text range excludes the consumed backslash of an escaped
		// punctuation character. Assign that unowned prefix to its text leaf so
		// a whole-cell rewrite cannot leave it before a newly inserted mark.
		const range = node.kind === 'text' && node.range.start > start && source[node.range.start - 1] === '\\'
			? { start: node.range.start - 1, end: node.range.end } : node.range;
		start = node.range.end;
		return { ...node, range, children: tableSourceNodes(source, node.children, node.range.start) };
	});
}

type TableMarkdownMark = 'strong' | 'emphasis' | 'strikethrough';
interface TableInlineAtom { readonly marks: readonly TableMarkdownMark[]; readonly text?: string; readonly code?: boolean; readonly source?: string; }
interface TableInlinePiece { value: string; readonly text?: string; first?: boolean; last?: boolean; readonly mark?: TableMarkdownMark; readonly opening?: boolean; }
const tableMarkdownMarks: readonly TableMarkdownMark[] = ['strong', 'emphasis', 'strikethrough'];
const tableMarkdownDelimiters = { strong: '**', emphasis: '_', strikethrough: '~~' } as const;

function tableInlineSource(source: string, nodes: readonly ArkdownNode[], format: Exclude<ArkdownTableCellFormat, ArkdownInlineFormat>): string {
	const render = (children: readonly ArkdownNode[], inherited: readonly TableMarkdownMark[], suppressed: readonly TableMarkdownMark[]): string => {
		const atoms: TableInlineAtom[] = [];
		const append = (atom: TableInlineAtom): void => {
			const previous = atoms.at(-1);
			if (atom.text !== undefined && previous?.text !== undefined && atom.code === previous.code && atom.marks.join() === previous.marks.join()) {
				atoms[atoms.length - 1] = { ...atom, text: previous.text + atom.text };
			} else atoms.push(atom);
		};
		const visit = (node: ArkdownNode, marks: readonly TableMarkdownMark[]): void => {
			if (tableMarkdownMarks.includes(node.kind as TableMarkdownMark)) {
				const kind = node.kind as TableMarkdownMark;
				const next = kind === format.kind || marks.includes(kind) || suppressed.includes(kind) ? marks : tableMarkdownMarks.filter(mark => mark === kind || marks.includes(mark));
				for (const child of node.children) visit(child, next);
			} else if (node.kind === 'image') {
				append({ marks, source: source.slice(node.range.start, node.range.end) });
			} else if (node.children.length) {
				const first = node.children[0].range.start, last = node.children.at(-1)!.range.end;
				const content = render(node.children, [], [...suppressed, ...marks]);
				// Autolink labels cannot contain inline syntax. An explicit link keeps
				// the same destination while allowing marks inside its visible label.
				const value = node.kind === 'link' && source[node.range.start] === '<'
					? `[${content}](<${node.destination!.replace(/[\\<>|]/g, '\\$&')}>)`
					: source.slice(node.range.start, first) + content + source.slice(last, node.range.end);
				append({ marks, source: value });
			} else if (node.text !== undefined) {
				append({ marks, text: node.text, code: format.kind === 'code' ? format.active : node.kind === 'code' });
			} else append({ marks, source: source.slice(node.range.start, node.range.end) });
		};
		for (const node of children) visit(node, inherited);
		const pieces: TableInlinePiece[] = [];
		let open: readonly TableMarkdownMark[] = [];
		for (const atom of atoms) {
			let shared = 0;
			while (shared < open.length && open[shared] === atom.marks[shared]) shared++;
			for (let index = open.length - 1; index >= shared; index--) pieces.push({ value: tableMarkdownDelimiters[open[index]], mark: open[index], opening: false });
			for (let index = shared; index < atom.marks.length; index++) pieces.push({ value: tableMarkdownDelimiters[atom.marks[index]], mark: atom.marks[index], opening: true });
			if (atom.text !== undefined) {
				if (atom.code) pieces.push({ value: tableCodeSource(atom.text) });
				else if (atom.text) pieces.push({ value: tableLiteralSource(atom.text), text: atom.text });
			} else if (atom.source) pieces.push({ value: atom.source });
			open = atom.marks;
		}
		for (let index = open.length - 1; index >= 0; index--) pieces.push({ value: tableMarkdownDelimiters[open[index]], mark: open[index], opening: false });
		// Removing one mark can change the flanking of another, especially an
		// intraword underscore around punctuation. Character references change
		// the source boundary to punctuation without changing any visible text.
		const encodeEdge = (piece: TableInlinePiece | undefined, first: boolean): void => {
			if (piece?.text === undefined) return;
			if (first) piece.first = true; else piece.last = true;
			const chars = Array.from(piece.text);
			piece.value = chars.map((char, index) => piece.first && index === 0 || piece.last && index === chars.length - 1 ? `&#${char.codePointAt(0)};` : tableLiteralSource(char)).join('');
		};
		// A code span may contain edge spaces that would otherwise become table
		// padding when its fences are removed.
		if (pieces[0]?.text && /^\s/u.test(pieces[0].text)) encodeEdge(pieces[0], true);
		const last = pieces.at(-1);
		if (last?.text && /\s$/u.test(last.text)) encodeEdge(last, false);
		for (let index = 0; index < pieces.length; index++) {
			const piece = pieces[index];
			if (!piece.mark) continue;
			const previous = pieces[index - 1], next = pieces[index + 1];
			const before = previous ? Array.from(previous.value).at(-1) ?? '' : '', after = next ? Array.from(next.value)[0] ?? '' : '';
			const whitespace = (char: string): boolean => !char || /\s/u.test(char);
			const punctuation = (char: string): boolean => /[\p{P}\p{S}]/u.test(char);
			const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before));
			const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after));
			const valid = piece.opening ? left && (piece.mark !== 'emphasis' || !right || punctuation(before)) : right && (piece.mark !== 'emphasis' || !left || punctuation(after));
			if (!valid) { encodeEdge(previous, false); encodeEdge(next, true); }
		}
		return pieces.map(piece => piece.value).join('');
	};
	return render(nodes, format.kind !== 'code' && format.active ? [format.kind] : [], []);
}

function tableLiteralSource(value: string): string {
	return value.replace(/[\\`*_![\]<>|~&\r\n\t]/g, char => char === '&' ? '&amp;' : char === '\r' ? '&#13;' : char === '\n' ? '&#10;' : char === '\t' ? '&#9;' : `\\${char}`);
}

function tableCodeSource(value: string): string {
	return value.split(/([\r\n\t])/).map(part => {
		if (!part) return '';
		if (/^[\r\n\t]$/.test(part)) return tableLiteralSource(part);
		let length = 1;
		for (const run of part.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
		const fence = '`'.repeat(length);
		const padding = part.startsWith('`') || part.endsWith('`') || part.startsWith(' ') && part.endsWith(' ') && /[^ ]/.test(part) ? ' ' : '';
		return fence + padding + part.replace(/\|/g, '\\|') + padding + fence;
	}).join('');
}

/** Rewrites only one kind of inline mark. Existing Markdown syntax and other
 * marks remain source-backed; selected leaf ranges retain their caret mapping.
 * Rebuilding the affected blocks also splits inherited marks when only part of
 * a colored or underlined span is cleared, without leaving a nested override. */
export function formatArkdownInline(source: string, nodes: readonly ArkdownNode[], selection: ArkdownRange, format: ArkdownInlineFormat): { range: ArkdownRange; text: string; selection: ArkdownRange; } | undefined {
	if (selection.start === selection.end) return undefined;
	const roots = nodes.filter(node => node.range.start < selection.end && node.range.end > selection.start);
	if (!roots.length) return undefined;
	const range = { start: roots[0].range.start, end: roots.at(-1)!.range.end };
	const close = format.kind === 'text_color' ? '</span>' : format.kind === 'underline' ? '</u>' : '</mark>';
	const open = (color?: ArkdownTextColor): string => format.kind === 'text_color'
		? `<span data-text-color="${color}">` : format.kind === 'underline' ? '<u>' : '<mark>';
	const chosen = format.kind === 'text_color' ? format.color ? open(format.color) : undefined : format.active ? open() : undefined;
	const pieces: string[] = [];
	let length = 0, selectedStart: number | undefined, selectedEnd: number | undefined;
	const append = (value: string): void => { pieces.push(value); length += value.length; };
	const leaf = (start: number, end: number, style: string | undefined): void => {
		if (start >= end) return;
		if (style) append(style);
		if (start < selection.end && end > selection.start) {
			selectedStart ??= length + Math.max(0, selection.start - start);
			selectedEnd = length + Math.min(end, selection.end) - start;
		}
		append(source.slice(start, end));
		if (style) append(close);
	};
	const children = (node: ArkdownNode, start: number, end: number, inherited: string | undefined): void => {
		let cursor = start;
		for (const child of node.children) {
			// Task markers in loose lists can precede their paragraph's own range.
			if (child.range.start < cursor || child.range.end > end) continue;
			append(source.slice(cursor, child.range.start));
			visit(child, inherited);
			cursor = child.range.end;
		}
		append(source.slice(cursor, end));
	};
	const visit = (node: ArkdownNode, inherited: string | undefined): void => {
		if (node.kind === 'code_block' || node.kind === 'html_block') {
			append(source.slice(node.range.start, node.range.end));
			return;
		}
		if (node.kind === format.kind) {
			const start = source.indexOf('>', node.range.start) + 1;
			const end = source.lastIndexOf('</', node.range.end - 1);
			children(node, start, end, open(node.color));
		} else if (node.children.length) {
			children(node, node.range.start, node.range.end, inherited);
		} else if (node.text !== undefined && node.kind !== 'raw_html') {
			const start = Math.max(node.range.start, selection.start), end = Math.min(node.range.end, selection.end);
			if (start < end) {
				// A code span's delimiters must stay together; its whole span receives the mark.
				if (node.kind === 'code') leaf(node.range.start, node.range.end, chosen);
				else {
					leaf(node.range.start, start, inherited);
					leaf(start, end, chosen);
					leaf(end, node.range.end, inherited);
				}
			} else leaf(node.range.start, node.range.end, inherited);
		} else append(source.slice(node.range.start, node.range.end));
	};
	let cursor = range.start;
	for (const root of roots) {
		append(source.slice(cursor, root.range.start));
		visit(root, undefined);
		cursor = root.range.end;
	}
	const text = pieces.join('');
	if (selectedStart === undefined || selectedEnd === undefined || text === source.slice(range.start, range.end)) return undefined;
	return { range, text, selection: { start: range.start + selectedStart, end: range.start + selectedEnd } };
}
