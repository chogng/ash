import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../../../base/common/errors.js';
import type { ToolResultPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatSessionNavigationService } from '../../../../../../services/chat/common/chatSessionNavigationService.js';
import { localize } from '../../../../../../../nls.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import '../media/chatSessionCreatedResult.css';

/** Navigation stays with the result's original host; the source draft is not consumed. */
export class ChatSessionTargetResultPillSubPart extends BaseChatToolInvocationSubPart {
	private controller = new AbortController();
	private readonly actions: Button[] = [];
	private opening = false;
	protected readonly controls: HTMLElement;
	constructor(document: Document, private readonly target: Extract<ToolResultPresentation, { type: 'sessionTarget'; }>, private readonly sourceSessionId: string,
		@IChatSessionNavigationService protected readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(h(document, 'section', { className: 'ash-chat-created-result' }));
		const label = h(document, 'p');
		label.textContent = target.label;
		this.controls = h(document, 'div');
		this.domNode.append(label, this.controls);
		this.addOpenAction(localize('chat.tool.openSessionResult', 'Open conversation'));
		this._register(toDisposable(() => this.controller.abort()));
	}

	protected addOpenAction(label: string, sideBySide = false): void {
		const button = this._register(new Button(this.controls, {
			...defaultButtonStyles,
			label,
			onClick: () => {
				if (!this.navigation.openToolResult || this.opening || this.controller.signal.aborted || !this.domNode.isConnected) return;
				this.opening = true;
				const signal = this.controller.signal;
				for (const action of this.actions) action.enabled = false;
				void this.navigation.openToolResult(this.sourceSessionId, this.target, signal, sideBySide ? { sideBySide: true } : undefined).catch(error => {
					if (!signal.aborted && !isCancellationError(error)) this.notifications.error(String(error));
				}).finally(() => {
					if (!this.isDisposed && this.controller.signal === signal && !signal.aborted) this.resetActions();
				});
			},
		}));
		button.enabled = !!this.navigation.openToolResult;
		this.actions.push(button);
	}

	private resetActions(): void {
		this.opening = false;
		for (const action of this.actions) action.enabled = !!this.navigation.openToolResult;
	}
	public setVisible(visible: boolean): void {
		if (!visible) this.controller.abort();
		else if (this.controller.signal.aborted) {
			this.controller = new AbortController();
			this.resetActions();
		}
	}
}
