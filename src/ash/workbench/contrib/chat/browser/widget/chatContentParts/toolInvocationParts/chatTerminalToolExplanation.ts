import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../../base/common/uri.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import { IChatSideChatService } from '../../../../common/chatSideChatService.js';

/** An explanation borrows the original approval lifetime and never resolves that approval. */
export class ChatTerminalToolExplanation extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly button: Button;
	private lifetime = new AbortController();
	private visible = true;

	constructor(document: Document,
		private readonly context: { readonly resource: URI; readonly isCurrent: () => boolean; },
		private readonly command: string,
		@IChatSideChatService private readonly sideChats: IChatSideChatService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.hidden = !sideChats.canAskInSideChat(context.resource);
		this.button = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('chat.tool.explainCommand', 'Explain command'),
			presentation: 'secondary',
			onClick: () => { void this.explain(); },
		}));
		this._register(toDisposable(() => { this.lifetime.abort(); this.domNode.remove(); }));
	}

	public async explain(): Promise<void> {
		if (this.isDisposed || !this.visible || !this.button.enabled || !this.context.isCurrent() || !this.sideChats.canAskInSideChat(this.context.resource)) {
			return;
		}
		this.button.enabled = false;
		const lifetime = this.lifetime;
		try {
			await this.sideChats.askInSideChat(this.context.resource,
				localize('chat.tool.explainCommandQuery', 'Explain what this command and its arguments will do.'),
				{ text: this.command }, { signal: lifetime.signal });
		} catch (error) {
			if (!lifetime.signal.aborted && this.context.isCurrent()) {
				this.notifications.error(localize('chat.tool.explainCommandFailed', 'Could not explain the command: {0}', String(error)));
			}
		} finally {
			if (!this.isDisposed && this.lifetime === lifetime && this.context.isCurrent()) { this.button.enabled = true; }
		}
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (!visible) { this.lifetime.abort(); }
		else if (this.lifetime.signal.aborted) { this.lifetime = new AbortController(); }
		this.button.enabled = visible;
		this.domNode.hidden = !visible || !this.sideChats.canAskInSideChat(this.context.resource);
	}
}
