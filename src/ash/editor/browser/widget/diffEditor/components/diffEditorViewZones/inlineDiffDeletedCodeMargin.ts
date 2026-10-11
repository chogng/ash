import { h } from '../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { diffRemoveIcon } from '../../registrations.contribution.js';
import { appendRemoveOnDispose } from '../../utils.js';

/** Owns the deletion marker attached to an inline original-code view zone. */
export class InlineDiffDeletedCodeMargin extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(document: Document, decorationsWidth: number, renderIndicators: boolean) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-diff-inline-original-margin stanza-diff-gutter-removed';
		this.domNode.setAttribute('aria-hidden', 'true');
		if (renderIndicators) {
			const marker = h(document, 'div');
			marker.className = 'stanza-diff-remove-sign';
			marker.style.width = `${decorationsWidth}px`;
			appendIcon(diffRemoveIcon, marker);
			this._register(appendRemoveOnDispose(this.domNode, marker));
		}
	}
}
