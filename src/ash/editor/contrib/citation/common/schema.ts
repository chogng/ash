import type { DocumentAttributes } from "../../../common/model/document.js";
import type { DocumentNodeSpec } from "../../../common/model/documentSchema.js";

export const CITATION_NODE_TYPE = "citation";
export const BIBLIOGRAPHY_NODE_TYPE = "bibliography";
export const REFERENCE_NODE_TYPE = "reference";

export const citationNodeSpec: DocumentNodeSpec = Object.freeze({
	kind: "inline",
	validateAttributes: (attrs: DocumentAttributes) => {
		if (typeof attrs.key !== "string" || attrs.key.length === 0) throw new TypeError("Citation key must be a non-empty string");
		if (attrs.label !== undefined && typeof attrs.label !== "string") throw new TypeError("Citation label must be a string");
	},
});

export const bibliographyNodeSpec: DocumentNodeSpec = Object.freeze({
	kind: "group",
	groups: ["citation-bibliography"],
	content: [{ group: "citation-reference", min: 1 }],
});

export const referenceNodeSpec: DocumentNodeSpec = Object.freeze({
	kind: "block",
	groups: ["citation-reference"],
	content: [{ type: "paragraph", min: 1, max: 1 }],
	validateAttributes: (attrs: DocumentAttributes) => {
		if (typeof attrs.key !== "string" || attrs.key.length === 0) throw new TypeError("Reference key must be a non-empty string");
	},
});
