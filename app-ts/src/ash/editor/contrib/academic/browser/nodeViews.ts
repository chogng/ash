import { ACADEMIC_NODE_TYPES } from "../common/schema.js";
import type { NodeViewContext, NodeViewFactory } from "../../../browser/widget/richTextEditor/richTextEditorWidget.js";
import { h } from "../../../../base/browser/dom.js";

/** Browser projections for Academic wrapper nodes; child editing stays editor-owned. */
export const nodeViews: Readonly<Record<string, NodeViewFactory>> = Object.freeze({
	[ACADEMIC_NODE_TYPES.title]: context => createWrapper(context, "header", "title", "Document title"),
	[ACADEMIC_NODE_TYPES.abstract]: context => createWrapper(context, "section", "abstract", "Abstract"),
	[ACADEMIC_NODE_TYPES.section]: context => createWrapper(context, "section", "section"),
});

function createWrapper(context: NodeViewContext, tagName: "header" | "section", role: string, label?: string): HTMLElement {
	const element = context.previousElement ?? h(context.ownerDocument, tagName);
	element.className = "ash-academic-" + role;
	element.dataset.academicRole = role;
	if (label) element.setAttribute("aria-label", label);
	context.renderChildren(element);
	return element;
}
