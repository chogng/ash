import { h } from '../../../../../../base/browser/dom.js';
import { MarkdownElement } from '../../../../../../base/browser/markdownRenderer.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import type { IChatTip } from '../../chatTipService.js';

/** Renders one tip; the presenter owns visibility and the service owns dismissal. */
export class ChatTipContentPart extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(document: Document, tip: IChatTip, dismiss: () => void) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-cowork-input-tip';
		this.domNode.setAttribute('role', 'note');
		const content = this._register(new MarkdownElement({ ownerDocument: document, markdown: tip.content }));
		this.domNode.append(content.element);
		this._register(new Button(this.domNode, {
			label: localize('chat.tip.dismiss', 'Dismiss tip'),
			ariaLabel: localize('chat.tip.dismiss', 'Dismiss tip'),
			icon: Lxicon.close,
			iconOnly: true,
			onClick: dismiss,
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}
}
