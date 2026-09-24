import type { DocumentNode, DocumentNodeId } from "./document.js";

/** One navigable heading in a document outline. */
export interface DocumentOutlineEntry {
	readonly nodeId: DocumentNodeId;
	readonly parentHeadingId: DocumentNodeId | undefined;
	readonly depth: number;
	readonly level: number;
	readonly title: string;
}

export type DocumentOutline = readonly DocumentOutlineEntry[];

export interface DocumentOutlineOptions {
	/** Selects nodes that participate in the outline. Defaults to `heading`. */
	readonly isHeading?: (node: DocumentNode) => boolean;
	/** Reads a structural level from a selected node. Invalid values become level 1. */
	readonly getLevel?: (node: DocumentNode) => number;
	/** Produces the visible label for a selected node. */
	readonly getTitle?: (node: DocumentNode) => string;
}

/** Builds a stable, domain-neutral heading outline from a document tree. */
export function buildDocumentOutline(document: DocumentNode, options: DocumentOutlineOptions = {}): DocumentOutline {
	if (!document || typeof document !== "object") throw new TypeError("A document is required to build an outline");
	const entries: DocumentOutlineEntry[] = [];
	const headingStack: Array<{ readonly nodeId: DocumentNodeId; readonly level: number }> = [];
	const isHeading = options.isHeading ?? (node => node.type === "heading");
	const getLevel = options.getLevel ?? defaultHeadingLevel;
	const getTitle = options.getTitle ?? defaultHeadingTitle;

	const visit = (node: DocumentNode): void => {
		if (isHeading(node)) {
			const level = normalizeHeadingLevel(getLevel(node));
			while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
			entries.push(Object.freeze({
				nodeId: node.id,
				parentHeadingId: headingStack[headingStack.length - 1]?.nodeId,
				depth: headingStack.length,
				level,
				title: getTitle(node),
			}));
			headingStack.push({ nodeId: node.id, level });
		}
		for (const child of node.content) visit(child);
	};

	visit(document);
	return Object.freeze(entries);
}

function defaultHeadingLevel(node: DocumentNode): number {
	return typeof node.attrs.level === "number" ? node.attrs.level : 1;
}

function defaultHeadingTitle(node: DocumentNode): string {
	const parts: string[] = [];
	collectText(node, parts);
	return parts.join("").replace(/\s+/g, " ").trim();
}

function collectText(node: DocumentNode, parts: string[]): void {
	if (node.text !== undefined) {
		parts.push(node.text);
		return;
	}
	if (node.type === "hardBreak") {
		parts.push(" ");
		return;
	}
	if (node.type === "image") {
		const alt = node.attrs.alt;
		if (typeof alt === "string") parts.push(alt);
		return;
	}
	for (const child of node.content) collectText(child, parts);
}

function normalizeHeadingLevel(value: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
