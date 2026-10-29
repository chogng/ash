import {
	SyntaxKind,
	createScanner,
	findNodeAtLocation,
	parseTree,
	type JSONPath,
	type Node,
	type ParseError,
	type Segment,
} from './json.js';
import { format, isEOL, type Edit, type FormattingOptions } from './jsonFormatter.js';

export function removeProperty(
	text: string,
	path: JSONPath,
	formattingOptions: FormattingOptions = {},
): readonly Edit[] {
	return setProperty(text, path, undefined, formattingOptions);
}

export function setProperty(
	text: string,
	originalPath: JSONPath,
	value: unknown,
	formattingOptions: FormattingOptions = {},
	getInsertionIndex?: (properties: readonly string[]) => number,
): readonly Edit[] {
	const path = originalPath.slice();
	const errors: ParseError[] = [];
	const root = parseTree(text, errors);
	let parent: Node | undefined;
	let lastSegment: Segment | undefined;
	while (path.length > 0) {
		lastSegment = path.pop();
		parent = findNodeAtLocation(root, path);
		if (parent === undefined && value !== undefined) {
			if (typeof lastSegment === 'string') value = { [lastSegment]: value };
			else value = [value];
			continue;
		}
		break;
	}

	if (!parent) {
		if (value === undefined) return Object.freeze([]);
		return withFormatting(
			text,
			{ offset: root?.offset ?? 0, length: root?.length ?? 0, content: JSON.stringify(value) },
			formattingOptions,
		);
	}
	if (parent.type === 'object' && typeof lastSegment === 'string' && parent.children) {
		const existing = findNodeAtLocation(parent, [lastSegment]);
		if (existing) {
			if (value === undefined) {
				if (!existing.parent) throw new Error('Malformed JSON AST');
				return removeNode(text, parent, parent.children.indexOf(existing.parent), formattingOptions);
			}
			return withFormatting(
				text,
				{ offset: existing.offset, length: existing.length, content: JSON.stringify(value) },
				formattingOptions,
			);
		}
		if (value === undefined) return Object.freeze([]);
		const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
		const propertyNames = parent.children.map(property => String(property.children?.[0]?.value ?? ''));
		const insertionIndex = getInsertionIndex?.(propertyNames) ?? parent.children.length;
		const index = Math.max(0, Math.min(parent.children.length, insertionIndex));
		let edit: Edit;
		if (index > 0) {
			const previous = parent.children[index - 1]!;
			edit = { offset: previous.offset + previous.length, length: 0, content: `,${newProperty}` };
		} else if (parent.children.length === 0) {
			edit = { offset: parent.offset + 1, length: 0, content: newProperty };
		} else {
			edit = { offset: parent.offset + 1, length: 0, content: `${newProperty},` };
		}
		return withFormatting(text, edit, formattingOptions);
	}
	if (parent.type === 'array' && typeof lastSegment === 'number' && parent.children) {
		if (value !== undefined) {
			const index = Math.max(0, Math.min(parent.children.length, lastSegment));
			const serialized = JSON.stringify(value);
			if (index === 0) {
				const content = parent.children.length === 0 ? serialized : `${serialized},`;
				return withFormatting(text, { offset: parent.offset + 1, length: 0, content }, formattingOptions);
			}
			const previous = parent.children[index - 1];
			if (!previous) throw new Error('Malformed JSON AST');
			return withFormatting(
				text,
				{ offset: previous.offset + previous.length, length: 0, content: `,${serialized}` },
				formattingOptions,
			);
		}
		if (lastSegment < 0 || lastSegment >= parent.children.length) return Object.freeze([]);
		return removeNode(text, parent, lastSegment, formattingOptions);
	}
	throw new Error(
		`Cannot add ${typeof lastSegment === 'number' ? 'index' : 'property'} to parent of type ${parent.type}`,
	);
}

/** Remove the node and one separator, retaining comments outside the removed value. */
function removeNode(text: string, parent: Node, index: number, formattingOptions: FormattingOptions): readonly Edit[] {
	const node = parent.children![index]!;
	let begin = node.offset;
	let end = node.offset + node.length;
	let content = '';
	const scanner = createScanner(text, true);
	scanner.setPosition(end);
	if (scanner.scan() === SyntaxKind.CommaToken) {
		content = text.slice(end, scanner.getTokenOffset());
		end = scanner.getTokenOffset() + scanner.getTokenLength();
	} else if (index > 0) {
		const previous = parent.children![index - 1]!;
		scanner.setPosition(previous.offset + previous.length);
		if (scanner.scan() === SyntaxKind.CommaToken) {
			begin = scanner.getTokenOffset();
			content = text.slice(begin + scanner.getTokenLength(), node.offset);
		}
	}
	return withFormatting(text, { offset: begin, length: end - begin, content }, formattingOptions);
}

export function withFormatting(text: string, edit: Edit, formattingOptions: FormattingOptions = {}): readonly Edit[] {
	let newText = applyEdit(text, edit);
	let begin = edit.offset;
	let end = edit.offset + edit.content.length;
	if (edit.length === 0 || edit.content.length === 0) {
		while (begin > 0 && !isEOL(newText, begin - 1)) begin -= 1;
		while (end < newText.length && !isEOL(newText, end)) end += 1;
	}
	const edits = format(newText, { offset: begin, length: end - begin }, formattingOptions);
	for (let index = edits.length - 1; index >= 0; index -= 1) {
		const current = edits[index]!;
		newText = applyEdit(newText, current);
		begin = Math.min(begin, current.offset);
		end = Math.max(end, current.offset + current.length);
		end += current.content.length - current.length;
	}
	const editLength = text.length - (newText.length - end) - begin;
	return Object.freeze([{ offset: begin, length: editLength, content: newText.substring(begin, end) }]);
}

export function applyEdit(text: string, edit: Edit): string {
	if (edit.offset < 0 || edit.length < 0 || edit.offset + edit.length > text.length) {
		throw new RangeError('JSON edit is outside the document');
	}
	return `${text.slice(0, edit.offset)}${edit.content}${text.slice(edit.offset + edit.length)}`;
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
	const sortedEdits = edits.slice().sort((left, right) => left.offset - right.offset || left.length - right.length);
	let lastModifiedOffset = text.length;
	for (let index = sortedEdits.length - 1; index >= 0; index -= 1) {
		const edit = sortedEdits[index]!;
		if (edit.offset + edit.length > lastModifiedOffset) throw new Error('Overlapping JSON edit');
		text = applyEdit(text, edit);
		lastModifiedOffset = edit.offset;
	}
	return text;
}
