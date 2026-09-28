import './media/chatCodeSwitchWidget.css';
import { h } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { OpenInAshWidget } from './openInAshWidget.js';

/** A single titlebar control for the Chat and Code workspaces. */
export class ChatCodeSwitchWidget extends Disposable {
	readonly domNode: HTMLElement;
	private readonly chatButton: Button;
	private readonly codeButton: Button;

	constructor(container: HTMLElement, selectMode: (mode: 'chat' | 'code') => void) {
		super();
		this.domNode = h(container.ownerDocument, 'nav');
		this.domNode.className = 'ash-sessions-chat-code-switch';
		this.domNode.setAttribute('aria-label', localize('sessions.mode.switch', 'Chat and Code'));
		const chatLabel = localize('sessions.mode.chat', 'Chat');
		this.chatButton = this._register(new Button(this.domNode, {
			label: chatLabel,
			icon: Lxicon.chat1,
			iconOnly: true,
			ariaLabel: chatLabel,
			title: chatLabel,
			onClick: () => selectMode('chat'),
		}));
		this.codeButton = this._register(new OpenInAshWidget(this.domNode, () => selectMode('code'))).button;
		this.setMode('chat');
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	setMode(mode: 'chat' | 'code'): void {
		for (const [button, selected] of [[this.chatButton, mode === 'chat'], [this.codeButton, mode === 'code']] as const) {
			button.toggleClassName('selected', selected);
			button.domNode.setAttribute('aria-current', selected ? 'page' : 'false');
		}
	}
}
