import type { DocumentNode } from "../../../common/model/document.js";
import { type DocumentMarkSpec, type DocumentNodeSpec, DocumentSchema, createDefaultDocumentSchema } from "../../../common/model/documentSchema.js";
import { BIBLIOGRAPHY_NODE_TYPE, bibliographyNodeSpec, CITATION_NODE_TYPE, citationNodeSpec, REFERENCE_NODE_TYPE, referenceNodeSpec } from "../../citation/common/schema.js";

/** Node types owned by the Academic document profile. */
export const ACADEMIC_NODE_TYPES = Object.freeze({
	title: "title",
	abstract: "abstract",
	section: "section",
});

/** Creates the Academic schema while retaining the default document nodes. */
export function createAcademicDocumentSchema(): DocumentSchema {
	const defaults = createDefaultDocumentSchema();
	const nodes: Record<string, DocumentNodeSpec> = {};
	for (const [type, spec] of defaults.getNodeSpecs()) {
		if (type === defaults.topNodeType) {
			nodes[type] = {
				...spec,
				content: [
					{ type: ACADEMIC_NODE_TYPES.title, max: 1 },
					{ type: ACADEMIC_NODE_TYPES.abstract, max: 1 },
					{ group: "academic-section" },
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
	nodes[ACADEMIC_NODE_TYPES.title] = {
		kind: "group",
		groups: ["academic-meta"],
		content: [{ type: "heading", min: 1, max: 1 }],
	};
	nodes[ACADEMIC_NODE_TYPES.abstract] = {
		kind: "group",
		groups: ["academic-meta"],
		content: [{ type: "paragraph", min: 1, max: 1 }],
	};
	nodes[ACADEMIC_NODE_TYPES.section] = {
		kind: "group",
		groups: ["academic-section"],
		content: [{ type: "heading", min: 1, max: 1 }, { group: "block" }],
	};
	nodes[CITATION_NODE_TYPE] = citationNodeSpec;
	nodes[BIBLIOGRAPHY_NODE_TYPE] = bibliographyNodeSpec;
	nodes[REFERENCE_NODE_TYPE] = referenceNodeSpec;
	const marks: Record<string, DocumentMarkSpec> = Object.fromEntries(defaults.getMarkSpecs());
	return new DocumentSchema({ topNodeType: defaults.topNodeType, nodes, marks });
}

/** Creates the canonical empty Academic document used by new document flows. */
export function createEmptyAcademicDocument(schema: DocumentSchema = createAcademicDocumentSchema()): DocumentNode {
	const title = schema.createNode(ACADEMIC_NODE_TYPES.title, { content: [schema.createNode("heading")] });
	const abstract = schema.createNode(ACADEMIC_NODE_TYPES.abstract, { content: [schema.createNode("paragraph")] });
	return schema.createDocument([title, abstract]);
}
