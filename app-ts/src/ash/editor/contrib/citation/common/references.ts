import type { DocumentNode, DocumentNodeId } from "../../../common/model/document.js";
import { createDocumentPlugin, DocumentPluginKey, type DocumentPlugin } from "../../../common/model/documentPlugin.js";

export interface ReferenceEntry {
	readonly key: string;
	readonly nodeId: DocumentNodeId;
	readonly label: string;
	readonly ordinal: number;
}

export interface CitationEntry {
	readonly key: string;
	readonly nodeId: DocumentNodeId;
	readonly referenceNodeId: DocumentNodeId | undefined;
	readonly ordinal: number | undefined;
	readonly label: string | undefined;
}

export interface ReferenceIndex {
	readonly references: readonly ReferenceEntry[];
	readonly citations: readonly CitationEntry[];
	readonly unresolvedKeys: readonly string[];
	readonly duplicateKeys: readonly string[];
}

/** Shared state key for citation-to-reference resolution. */
export const REFERENCE_INDEX_KEY = new DocumentPluginKey<ReferenceIndex>("citation.referenceIndex");

/** Creates the plugin that resolves citation atoms to bibliography entries. */
export function createReferenceIndexPlugin(): DocumentPlugin<ReferenceIndex> {
	return createDocumentPlugin(REFERENCE_INDEX_KEY, {
		init: context => buildReferenceIndex(context.document),
		apply: (_value, context) => buildReferenceIndex(context.document),
	});
}

/** Scans one immutable document snapshot for bibliography definitions and citation uses. */
export function buildReferenceIndex(document: DocumentNode): ReferenceIndex {
	const references: ReferenceEntry[] = [];
	const citationNodes: Array<{ readonly key: string; readonly nodeId: DocumentNodeId }> = [];
	const visit = (node: DocumentNode): void => {
		if (node.type === "reference" && typeof node.attrs.key === "string" && node.attrs.key.length > 0) {
			references.push({ key: node.attrs.key, nodeId: node.id, label: readNodeText(node).trim() || node.attrs.key, ordinal: references.length + 1 });
		} else if (node.type === "citation" && typeof node.attrs.key === "string" && node.attrs.key.length > 0) {
			citationNodes.push({ key: node.attrs.key, nodeId: node.id });
		}
		for (const child of node.content) visit(child);
	};
	visit(document);

	const firstReferenceByKey = new Map<string, ReferenceEntry>();
	const duplicateKeys = new Set<string>();
	for (const reference of references) {
		if (firstReferenceByKey.has(reference.key)) duplicateKeys.add(reference.key);
		else firstReferenceByKey.set(reference.key, reference);
	}
	const unresolvedKeys = new Set<string>();
	const citations = citationNodes.map(citation => {
		const reference = firstReferenceByKey.get(citation.key);
		if (!reference) unresolvedKeys.add(citation.key);
		return Object.freeze({ key: citation.key, nodeId: citation.nodeId, referenceNodeId: reference?.nodeId, ordinal: reference?.ordinal, label: reference?.label });
	});
	return Object.freeze({
		references: Object.freeze(references.map(reference => Object.freeze(reference))),
		citations: Object.freeze(citations),
		unresolvedKeys: Object.freeze([...unresolvedKeys]),
		duplicateKeys: Object.freeze([...duplicateKeys]),
	});
}

function readNodeText(node: DocumentNode): string {
	if (node.text !== undefined) return node.text;
	if (node.type === "hardBreak") return " ";
	if (node.type === "image") return typeof node.attrs.alt === "string" ? node.attrs.alt : "";
	return node.content.map(readNodeText).join("");
}
