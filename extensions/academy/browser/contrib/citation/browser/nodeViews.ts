import { BIBLIOGRAPHY_NODE_TYPE, CITATION_NODE_TYPE, REFERENCE_NODE_TYPE } from '../common/schema.js';
import { REFERENCE_INDEX_KEY } from '../common/references.js';
import type { InlineNodeViewFactory, NodeViewContext, NodeViewFactory } from '../../../widget/richTextEditor/richTextEditorWidget.js';
import { h } from 'ash:editor/base/browser/dom.js';
import { localize } from 'ash:editor/nls.js';

/** Block projections owned by the citation capability. */
export const nodeViews: Readonly<Record<string, NodeViewFactory>> = Object.freeze({
	[BIBLIOGRAPHY_NODE_TYPE]: context => createWrapper(context, 'section', 'bibliography', localize('document.reference.heading', 'References')),
	[REFERENCE_NODE_TYPE]: context => {
		const element = context.previousElement ?? h(context.ownerDocument, 'article');
		element.className = 'ash-citation-reference';
		const key = typeof context.node.attrs.key === 'string' ? context.node.attrs.key : '';
		element.dataset.referenceKey = key;
		element.setAttribute('aria-label', localize('document.reference.accessible', 'Reference {0}', key));
		context.renderChildren(element);
		return element;
	},
});

/** Inline projection owned by the citation capability. */
export const inlineNodeViews: Readonly<Record<string, InlineNodeViewFactory>> = Object.freeze({
	[CITATION_NODE_TYPE]: context => {
		const element = h(context.ownerDocument, 'span');
		element.contentEditable = 'false';
		const key = typeof context.node.attrs.key === 'string' ? context.node.attrs.key : '';
		const explicitLabel = typeof context.node.attrs.label === 'string' && context.node.attrs.label.length > 0 ? context.node.attrs.label : undefined;
		const index = context.model.getPluginState(REFERENCE_INDEX_KEY);
		const entry = index?.citations.find(candidate => candidate.nodeId === context.node.id);
		const unresolved = index !== undefined && entry?.ordinal === undefined;
		const label = explicitLabel ?? (entry?.ordinal === undefined ? '[' + key + ']' : '[' + entry.ordinal + ']');
		element.className = unresolved ? 'ash-citation ash-citation-unresolved' : 'ash-citation';
		element.dataset.citationKey = key;
		if (entry?.ordinal !== undefined) element.dataset.citationOrdinal = String(entry.ordinal);
		element.textContent = label;
		element.setAttribute('role', 'button');
		element.setAttribute('tabindex', '0');
		const accessibleLabel = unresolved
			? localize('document.citation.unresolved', 'Unresolved citation {0}', key)
			: localize('document.citation.accessible', 'Citation {0}: {1}', key, entry?.label ?? label);
		element.setAttribute('aria-label', accessibleLabel);
		element.title = accessibleLabel;
		if (unresolved) element.setAttribute('aria-invalid', 'true');
		element.addEventListener('click', event => {
			event.preventDefault();
			context.select();
		});
		element.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			context.select();
			element.focus();
		});
		element.addEventListener('keyup', event => {
			if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
		});
		return element;
	},
});

function createWrapper(context: NodeViewContext, tagName: 'section', role: string, label: string): HTMLElement {
	const element = context.previousElement ?? h(context.ownerDocument, tagName);
	element.className = 'ash-citation-' + role;
	element.dataset.citationRole = role;
	element.setAttribute('aria-label', label);
	context.renderChildren(element);
	return element;
}
