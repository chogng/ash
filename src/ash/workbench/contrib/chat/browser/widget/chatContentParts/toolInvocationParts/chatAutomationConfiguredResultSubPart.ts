import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ToolResultPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatSessionNavigationService } from '../../../../../../services/chat/common/chatSessionNavigationService.js';
import { localize } from '../../../../../../../nls.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** A creation receipt opens the live provider-owned definition instead of storing another catalogue. */
export class ChatAutomationConfiguredResultSubPart extends BaseChatToolInvocationSubPart {
	private controller = new AbortController();
	private readonly action: Button;
	private readonly supported: boolean;
	constructor(document: Document, target: Extract<ToolResultPresentation, { type: 'automationConfigured'; }>, sourceSessionId: string,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@INotificationService notifications: INotificationService,
	) {
		super(h(document, 'section'));
		this.supported = !!navigation.openToolResult;
		const label = h(document, 'p');
		label.textContent = localize('chat.tool.automationConfigured', 'Automation configured: {0}', target.label);
		this.domNode.append(label);
		const button = this.action = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('chat.tool.openAutomationResult', 'Review automation'),
			onClick: () => {
				if (this.controller.signal.aborted || !this.domNode.isConnected) return;
				button.enabled = false;
				const signal = this.controller.signal;
				void navigation.openToolResult?.(sourceSessionId, target, signal).catch(error => {
					if (!signal.aborted) notifications.error(String(error));
				}).finally(() => { if (!this.isDisposed && this.controller.signal === signal && !signal.aborted) button.enabled = !!navigation.openToolResult; });
			},
		}));
		button.enabled = !!navigation.openToolResult;
		this._register(toDisposable(() => this.controller.abort()));
	}
	public setVisible(visible: boolean): void {
		if (!visible) this.controller.abort();
		else if (this.controller.signal.aborted) { this.controller = new AbortController(); this.action.enabled = this.supported; }
	}
}
