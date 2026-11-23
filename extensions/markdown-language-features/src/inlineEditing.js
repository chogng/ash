import { normalizedOffset, sourceOffset, textEdit } from './sourceEdits.js';

const textSelector = '[data-md-start]';
const textKinds = new Set(['t', 'code', 'raw']);
const parents = new Set(['el', 'ol', 'a', 'img']);

function provisionalText(text) {
	return ['t', text, [0, text.length]];
}

export function draftBlocks(parsed, text) {
	if (!parsed?.blocks) return [{ start: 0, end: text.length, content: provisionalText(text) }];
	const blocks = parsed.blocks.map(([start, end, content]) => ({ start, end, content }));
	if (parsed.text === text) return blocks;
	const edit = textEdit(parsed.text, text);
	const shift = edit.text.length - (edit.end - edit.start);
	const before = [];
	const after = [];
	for (const block of blocks) {
		if (block.start <= edit.start && edit.end <= block.end) {
			const source = parsed.text.slice(block.start, block.end);
			const local = { start: edit.start - block.start, end: edit.end - block.start, text: edit.text };
			const draft = projectTextEdit(block.content, source, local, shift);
			if (draft) {
				return blocks.map(candidate => candidate === block
					? { start: block.start, end: block.end + shift, content: draft }
					: candidate.start < block.start ? candidate : { ...candidate, start: candidate.start + shift, end: candidate.end + shift });
			}
		}
		if (block.end <= edit.start && block.end > block.start) before.push(block);
		else if (block.start >= edit.end && block.end > block.start) after.push(block);
	}
	const start = before.at(-1)?.end ?? 0;
	const end = after.length ? after[0].start + shift : text.length;
	return [
		...before,
		...(end > start || text.length === 0 ? [{ start, end, content: provisionalText(text.slice(start, end)) }] : []),
		...after.map(block => ({ ...block, start: block.start + shift, end: block.end + shift })),
	];
}

// Keep the rendered formatting while Rust parses an ordinary text edit. Only
// text whose source range round-trips to the visible string is projected locally.
function projectTextEdit(tree, source, edit, shift) {
	let applied = false;
	function visit(node) {
		const [kind, value, detail] = node;
		if (parents.has(kind)) {
			const children = detail.map(visit);
			return children.some((child, index) => child !== detail[index]) ? [kind, value, children] : node;
		}
		if (kind === 'task' && detail >= edit.end) return [kind, value, detail + shift];
		if (!textKinds.has(kind)) return node;
		const [start, end] = detail;
		if (!applied && start <= edit.start && edit.end <= end) {
			const raw = source.slice(start, end);
			if (raw === value || raw.replace(/\r\n?/gu, '\n') === value) {
				applied = true;
				const next = source.slice(start, edit.start) + edit.text + source.slice(edit.end, end);
				return [kind, next.replace(/\r\n?/gu, '\n'), [start, end + shift]];
			}
		}
		return start >= edit.end ? [kind, value, [start + shift, end + shift]] : node;
	}
	const content = visit(tree);
	return applied ? content : undefined;
}

export function mappedText(element, value, [start, end]) {
	element.dataset.mdStart = start;
	element.dataset.mdEnd = end;
	element.textContent = value;
	if (!value) element.append(document.createElement('br'));
	return element;
}

function bounds(block, leaf) {
	const start = Number(block.dataset.start);
	return [start + Number(leaf.dataset.mdStart), start + Number(leaf.dataset.mdEnd)];
}

function elementOf(node) {
	return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function sourcePoint(view, text, node, offset) {
	if (!node || !view.contains(node)) return;
	if (node === view) return Number(view.children[offset]?.dataset.start ?? text.length);
	const element = elementOf(node);
	const block = element?.closest('.ash-markdown-block');
	if (!block) return;
	const leaf = element.closest(textSelector);
	if (leaf) {
		const [start, end] = bounds(block, leaf);
		const visible = leaf.textContent;
		const source = text.slice(start, end);
		const caret = document.createRange();
		caret.setStart(leaf, 0);
		caret.setEnd(node, offset);
		const position = caret.toString().length;
		if (source === visible) return start + position;
		if (source.replace(/\r\n?/gu, '\n') === visible) return start + sourceOffset(source, position);
		// Decoded entities and escapes are atomic in the source.
		return position ? end : start;
	}
	const caret = document.createRange();
	caret.setStart(node, offset);
	caret.collapse(true);
	for (const candidate of block.querySelectorAll(textSelector)) {
		if (caret.comparePoint(candidate, 0) >= 0) return bounds(block, candidate)[0];
	}
	const last = block.querySelectorAll(textSelector);
	return last.length ? bounds(block, last[last.length - 1])[1] : Number(block.dataset.end);
}

export function readSelection(view, text, target) {
	const selection = view.ownerDocument.getSelection();
	const anchor = target ? sourcePoint(view, text, target.startContainer, target.startOffset)
		: sourcePoint(view, text, selection.anchorNode, selection.anchorOffset);
	const focus = target ? sourcePoint(view, text, target.endContainer, target.endOffset)
		: sourcePoint(view, text, selection.focusNode, selection.focusOffset);
	if (anchor === undefined || focus === undefined) return;
	return { anchor, focus };
}

function domPoint(view, text, offset) {
	const blocks = [...view.children];
	const block = blocks.find(element => Number(element.dataset.start) <= offset && offset < Number(element.dataset.end)) ?? blocks.at(-1);
	if (!block) return [view, 0];
	const leaves = [...block.querySelectorAll(textSelector)];
	let last;
	for (const leaf of leaves) {
		const [start, end] = bounds(block, leaf);
		if (offset < start) return [leaf.firstChild ?? leaf, 0];
		if (offset <= end) {
			const source = text.slice(start, end);
			const visible = leaf.textContent;
			const position = source === visible ? offset - start
				: source.replace(/\r\n?/gu, '\n') === visible ? normalizedOffset(source, offset - start)
					: offset === start ? 0 : visible.length;
			return [leaf.firstChild ?? leaf, position];
		}
		last = leaf;
	}
	if (last) return [last.firstChild ?? last, last.textContent.length];
	return [view, blocks.indexOf(block) + 1];
}

export function restoreSelection(view, text, selection) {
	const [anchor, anchorOffset] = domPoint(view, text, selection.anchor);
	const [focus, focusOffset] = domPoint(view, text, selection.focus);
	view.ownerDocument.getSelection().setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
}

export function rebaseSelection(selection, before, after) {
	if (!selection || before === after) return selection;
	if (before.replace(/\r\n?/gu, '\n') === after.replace(/\r\n?/gu, '\n')) {
		const position = offset => sourceOffset(after, normalizedOffset(before, offset));
		return { anchor: position(selection.anchor), focus: position(selection.focus) };
	}
	const edit = textEdit(before, after);
	const position = offset => offset < edit.start ? offset
		: offset <= edit.end ? edit.start + Math.min(offset - edit.start, edit.text.length)
			: offset + edit.text.length - (edit.end - edit.start);
	return { anchor: position(selection.anchor), focus: position(selection.focus) };
}
