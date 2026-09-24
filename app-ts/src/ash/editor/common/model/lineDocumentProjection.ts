import type { DocumentAttributes, DocumentMark, DocumentNode } from './document.js';
import type { DocumentSchema } from './documentSchema.js';
import { createLineDocumentSnapshot, linePoint, type InlineAtom, type LineDocumentSnapshot, type LineFacet, type LineId, type LineRegion, type LineRelation, type LineSemanticAttributes, type LineSemanticValue, type ModelLine, type PersistentMark } from './lineDocument.js';

/** Converts a schema document into the line-first snapshot consumed by TextModel. */
export function projectDocumentToLines(schema: DocumentSchema, document: DocumentNode): LineDocumentSnapshot {
	const projection = new DocumentLineProjection(schema, document.id);
	projection.visit(document, []);
	return projection.finish();
}

class DocumentLineProjection {
	private readonly lines: ModelLine[] = [];
	private readonly marks: PersistentMark[] = [];
	private readonly atoms: InlineAtom[] = [];
	private readonly facets: LineFacet[] = [];
	private readonly regions: LineRegion[] = [];
	private readonly relations: LineRelation[] = [];
	private readonly lineIds = new Set<LineId>();

	constructor(private readonly schema: DocumentSchema, private readonly documentId: string) {}

	public visit(node: DocumentNode, ancestors: readonly DocumentNode[]): void {
		const kind = this.schema.getNodeSpec(node.type)?.kind;
		if (kind === 'root') {
			for (const child of node.content) this.visit(child, ancestors);
			return;
		}
		if (kind === 'group') {
			for (const child of node.content) this.visit(child, [...ancestors, node]);
			return;
		}
		if (kind === 'line') {
			this.appendInlineLines(node, node.content, [...ancestors, node]);
			return;
		}
		if (kind !== 'block') return;

		const semanticAncestors = [...ancestors, node];
		const startLineIndex = this.lines.length;
		if (isBlockAtom(node)) {
			const atomLine = this.appendBlockAtom(node, semanticAncestors);
			const captionStart = this.lines.length;
			for (const child of node.content) this.visit(child, semanticAncestors);
			const captionLine = this.lines[captionStart];
			if (node.type === 'imageBlock' && captionLine) {
				this.relations.push({
					id: `${node.id}:caption`,
					kind: 'caption',
					source: { kind: 'line', lineId: captionLine.id },
					target: { kind: 'atom', atomId: node.id },
					attrs: { targetLineId: atomLine.id },
				});
			}
		} else {
			const directLines = node.content.filter(child => this.schema.getNodeSpec(child.type)?.kind === 'line');
			if (directLines.length > 0) {
				for (const child of directLines) this.visit(child, semanticAncestors);
			} else if (hasDirectInlineContent(node, this.schema) || isLegacyTextLine(node)) {
				this.appendInlineLines(node, node.content, semanticAncestors);
			} else {
				for (const child of node.content) this.visit(child, semanticAncestors);
				if (this.lines.length === startLineIndex) this.appendInlineLines(node, [], semanticAncestors);
			}
		}

		if (node.type === 'codeBlock' && this.lines.length > startLineIndex) {
			this.regions.push({
				id: `${node.id}:region`,
				kind: 'code',
				startLineId: this.lines[startLineIndex]!.id,
				endLineId: this.lines[this.lines.length - 1]!.id,
				attrs: {
					nodeId: node.id,
					languageId: typeof node.attrs.language === 'string' ? node.attrs.language : 'text',
					...toSemanticAttributes(node.attrs),
				},
			});
		}
	}

	public finish(): LineDocumentSnapshot {
		if (this.lines.length === 0) this.lines.push({ id: this.allocateLineId(`${this.documentId}:line`, 0), text: '' });
		return createLineDocumentSnapshot({
			lines: this.lines,
			marks: this.marks,
			atoms: this.atoms,
			facets: this.facets,
			regions: this.regions,
			relations: this.relations,
		});
	}

	private appendBlockAtom(node: DocumentNode, ancestors: readonly DocumentNode[]): ModelLine {
		const line = { id: this.allocateLineId(node.id, 0), text: OBJECT_REPLACEMENT_CHARACTER };
		this.lines.push(line);
		this.atoms.push({
			id: node.id,
			kind: blockAtomKind(node),
			position: linePoint(line.id, 0),
			display: 'block',
			attrs: { nodeId: node.id, ...toSemanticAttributes(node.attrs) },
		});
		this.appendFacets(line.id, ancestors);
		return line;
	}

	private appendInlineLines(owner: DocumentNode, content: readonly DocumentNode[], ancestors: readonly DocumentNode[]): void {
		let lineIndex = 0;
		let lineId = this.allocateLineId(owner.id, lineIndex);
		let text = '';
		const pendingMarks: PersistentMark[] = [];
		const pendingAtoms: InlineAtom[] = [];
		const finishLine = (): void => {
			this.lines.push({ id: lineId, text });
			this.marks.push(...pendingMarks.splice(0));
			this.atoms.push(...pendingAtoms.splice(0));
			this.appendFacets(lineId, ancestors);
		};
		const startNextLine = (): void => {
			finishLine();
			lineIndex += 1;
			lineId = this.allocateLineId(owner.id, lineIndex);
			text = '';
		};

		for (const child of content) {
			if (child.text !== undefined) {
				const segments = normalizeLineEndings(child.text).split('\n');
				for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
					const segment = segments[segmentIndex]!;
					const start = text.length;
					text += segment;
					for (let markIndex = 0; markIndex < child.marks.length; markIndex += 1) {
						const mark = child.marks[markIndex]!;
						if (segment.length > 0) pendingMarks.push(this.createMark(child.id, mark, markIndex, lineId, start, text.length));
					}
					if (segmentIndex < segments.length - 1) startNextLine();
				}
				continue;
			}
			const kind = this.schema.getNodeSpec(child.type)?.kind;
			if (kind !== 'inline') continue;
			const offset = text.length;
			text += OBJECT_REPLACEMENT_CHARACTER;
			pendingAtoms.push({
				id: child.id,
				kind: child.type,
				position: linePoint(lineId, offset),
				display: 'inline',
				attrs: { nodeId: child.id, ...inlineAtomAttributes(child) },
			});
		}
		finishLine();
	}

	private appendFacets(lineId: LineId, nodes: readonly DocumentNode[]): void {
		for (const node of nodes) {
			const kind = this.schema.getNodeSpec(node.type)?.kind;
			if (kind !== 'group' && kind !== 'block' && kind !== 'line') continue;
			this.facets.push({
				id: `${node.id}:facet:${lineId}`,
				kind: node.type,
				lineId,
				attrs: { nodeId: node.id, ...toSemanticAttributes(node.attrs) },
			});
		}
	}

	private createMark(textNodeId: string, mark: DocumentMark, markIndex: number, lineId: LineId, start: number, end: number): PersistentMark {
		return {
			id: `${textNodeId}:mark:${markIndex}:${lineId}`,
			kind: mark.type,
			from: linePoint(lineId, start),
			to: linePoint(lineId, end),
			attrs: toSemanticAttributes(mark.attrs),
		};
	}

	private allocateLineId(ownerId: string, lineIndex: number): LineId {
		const base = lineIndex === 0 ? ownerId : `${ownerId}:line:${lineIndex + 1}`;
		let candidate = base;
		let collision = 2;
		while (this.lineIds.has(candidate)) candidate = `${base}:${collision++}`;
		this.lineIds.add(candidate);
		return candidate;
	}
}

function hasDirectInlineContent(node: DocumentNode, schema: DocumentSchema): boolean {
	return node.content.some(child => child.text !== undefined || schema.getNodeSpec(child.type)?.kind === 'inline');
}

function isLegacyTextLine(node: DocumentNode): boolean {
	return node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock';
}

function isBlockAtom(node: DocumentNode): boolean {
	return node.type === 'imageBlock' ||
		node.type === 'horizontalRule' ||
		typeof node.attrs.src === 'string' && node.content.every(child => child.text === undefined);
}

function blockAtomKind(node: DocumentNode): string {
	return node.type === 'imageBlock' ? 'image' : node.type;
}

function inlineAtomAttributes(node: DocumentNode): LineSemanticAttributes {
	if (node.type === 'citation' && typeof node.attrs.key === 'string') {
		return { referenceIds: [node.attrs.key], ...toSemanticAttributes(node.attrs) };
	}
	return toSemanticAttributes(node.attrs);
}

function toSemanticAttributes(attrs: DocumentAttributes): LineSemanticAttributes {
	return attrs as Readonly<Record<string, LineSemanticValue>>;
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n|\r|\u2028|\u2029/gu, '\n');
}

const OBJECT_REPLACEMENT_CHARACTER = '\uFFFC';
