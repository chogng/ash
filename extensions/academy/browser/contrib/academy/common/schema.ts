import type { DocumentNode } from "../../../../common/model/document.js";
import { type DocumentMarkSpec, type DocumentNodeSpec, DocumentSchema, createDefaultDocumentSchema } from "../../../../common/model/documentSchema.js";
import { BIBLIOGRAPHY_NODE_TYPE, bibliographyNodeSpec, CITATION_NODE_TYPE, citationNodeSpec, REFERENCE_NODE_TYPE, referenceNodeSpec } from "../../citation/common/schema.js";

/** Node types owned by the Academy document profile. */
export const ACADEMY_NODE_TYPES = Object.freeze({
	title: "title",
	abstract: "abstract",
	section: "section",
});

/** Creates the Academy schema while retaining the default document nodes. */
export function createAcademyDocumentSchema(): DocumentSchema {
	const defaults = createDefaultDocumentSchema();
	const nodes: Record<string, DocumentNodeSpec> = {};
	for (const [type, spec] of defaults.getNodeSpecs()) {
		if (type === defaults.topNodeType) {
			nodes[type] = {
				...spec,
				content: [
					{ type: ACADEMY_NODE_TYPES.title, max: 1 },
					{ type: ACADEMY_NODE_TYPES.abstract, max: 1 },
					{ group: "academy-section" },
					{ group: "citation-bibliography", max: 1 },
					{ group: "block" },
				],
				allowedChildren: undefined,
			};
			continue;
		}
		if (type === "paragraph" || type === "heading") {
			nodes[type] = {
				...spec,
				allowedChildren: [...(spec.allowedChildren ?? []), CITATION_NODE_TYPE],
				groups: [...new Set([...(spec.groups ?? []), "block"])],
			};
		} else {
			nodes[type] = spec.kind === "block"
				? { ...spec, groups: [...new Set([...(spec.groups ?? []), "block"])] }
				: spec;
		}
	}
	nodes.documentSection = { ...nodes.documentSection!, allowedChildren: undefined, allowedChildGroups: ["block", "academy-meta", "academy-section", "citation-bibliography"] };
	nodes[ACADEMY_NODE_TYPES.title] = {
		kind: "group",
		groups: ["academy-meta"],
		content: [{ type: "heading", min: 1, max: 1 }],
	};
	nodes[ACADEMY_NODE_TYPES.abstract] = {
		kind: "group",
		groups: ["academy-meta"],
		content: [{ type: "paragraph", min: 1, max: 1 }],
	};
	nodes[ACADEMY_NODE_TYPES.section] = {
		kind: "group",
		groups: ["academy-section"],
		content: [{ type: "heading", min: 1, max: 1 }, { group: "block" }],
	};
	nodes[CITATION_NODE_TYPE] = citationNodeSpec;
	nodes[BIBLIOGRAPHY_NODE_TYPE] = bibliographyNodeSpec;
	nodes[REFERENCE_NODE_TYPE] = referenceNodeSpec;
	const marks: Record<string, DocumentMarkSpec> = Object.fromEntries(defaults.getMarkSpecs());
	return new DocumentSchema({ documentType: "academy", topNodeType: defaults.topNodeType, nodes, marks });
}

/** Creates the canonical empty Academy document used by new document flows. */
export function createEmptyAcademyDocument(schema: DocumentSchema = createAcademyDocumentSchema()): DocumentNode {
	const title = schema.createNode(ACADEMY_NODE_TYPES.title, { content: [schema.createNode("heading")] });
	const abstract = schema.createNode(ACADEMY_NODE_TYPES.abstract, { content: [schema.createNode("paragraph")] });
	return schema.createDocument([title, abstract]);
}
