import { ACADEMY_NODE_TYPES } from '../common/schema.js';
import type { NodeViewContext, NodeViewFactory } from '../../../widget/richTextEditor/richTextEditorWidget.js';
import { h } from 'ash:editor/base/browser/dom.js';

/** Browser projections for Academy wrapper nodes; child editing stays editor-owned. */
export const nodeViews: Readonly<Record<string, NodeViewFactory>> = Object.freeze({
	[ACADEMY_NODE_TYPES.title]: context => createWrapper(context, 'header', 'title', 'Document title'),
	[ACADEMY_NODE_TYPES.abstract]: context => createWrapper(context, 'section', 'abstract', 'Abstract'),
	[ACADEMY_NODE_TYPES.section]: context => createWrapper(context, 'section', 'section'),
});

function createWrapper(context: NodeViewContext, tagName: 'header' | 'section', role: string, label?: string): HTMLElement {
	const element = context.previousElement ?? h(context.ownerDocument, tagName);
	element.className = 'ash-academy-' + role;
	element.dataset.academyRole = role;
	if (label) element.setAttribute('aria-label', label);
	context.renderChildren(element);
	return element;
}
