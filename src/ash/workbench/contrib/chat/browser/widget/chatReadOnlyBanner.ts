import './media/chatReadOnlyBanner.css';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';

/** Keeps the archived transcript readable and routes restoration to the existing session action. */
export class ChatReadOnlyBanner extends Disposable {
	readonly domNode: HTMLElement;
	private readonly action: Button;
	private sessionId: string | undefined;
	private restoringSessionId: string | undefined;

	constructor(document: Document, private readonly restore: (sessionId: string) => Promise<void>) {
		super();
		this.domNode = h(document, 'div', { className: 'ash-chat-readonly-banner' });
		this.domNode.tabIndex = -1;
		this.domNode.hidden = true;
		appendIcon(Lxicon.lock, this.domNode);
		this.domNode.append(h(document, 'span', { className: 'ash-chat-readonly-message', attributes: { role: 'status' } },
			localize('chatReadOnlyBanner.archivedMessage', 'This conversation is archived.')));
		this.action = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('chatSession.restore', 'Restore'),
			presentation: 'secondary',
			size: 'small',
			onClick: () => { void this.restoreSession(); },
		}));
	}

	get visible(): boolean { return !this.domNode.hidden; }

	render(visible: boolean, sessionId: string | undefined): void {
		this.domNode.hidden = !visible;
		this.sessionId = sessionId;
		this.action.domNode.hidden = !sessionId;
		const restoring = !!sessionId && this.restoringSessionId === sessionId;
		this.action.enabled = !!sessionId && !restoring;
		this.domNode.setAttribute('aria-busy', String(restoring));
	}

	focus(): void {
		if (this.action.enabled) this.action.focus();
		else this.domNode.focus();
	}

	private async restoreSession(): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId || this.restoringSessionId) return;
		this.restoringSessionId = sessionId;
		this.render(this.visible, sessionId);
		try {
			await this.restore(sessionId);
		} finally {
			this.restoringSessionId = undefined;
			if (!this.isDisposed) this.render(this.visible, this.sessionId);
		}
	}
}
