import { h } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { IMcpServerManagementService } from '../../../../../../../platform/mcp/common/mcpServerManagementService.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Credentials go to the connection-owned MCP service; sign-in does not approve tool execution. */
export class ChatToolAuthenticationSubPart extends AbstractToolConfirmationSubPart {
	private controller = new AbortController();
	private action: Button | undefined;
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>, private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'authentication'; }>, private readonly serverId: string,
		@IMcpServerManagementService private readonly servers: IMcpServerManagementService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(document, resolve); this._register(toDisposable(() => this.controller.abort())); }
	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		this.controller.abort();
		this.controller = new AbortController();
		const root = h(this.domNode.ownerDocument, 'section');
		root.append(h(root.ownerDocument, 'p', {}, request.reason));
		const action = this.action = this.content.add(new Button(root, {
			...defaultButtonStyles,
			label: localize('chat.tool.signInProvider', 'Sign in to {0}', this.presentation.provider),
			onClick: () => {
				if (this.controller.signal.aborted || !this.domNode.isConnected) return;
				const signal = this.controller.signal;
				action.enabled = false;
				void this.servers.login(this.serverId, undefined, signal).then(() => {
					if (!signal.aborted) status(localize('chat.tool.authReady', 'Sign-in completed. Review the tool approval to continue.'));
				}, error => { if (!signal.aborted) this.notifications.error(String(error)); }).finally(() => {
					if (!this.isDisposed && signal === this.controller.signal && !signal.aborted) action.enabled = this.servers.isOAuthAvailable;
				});
			},
		}));
		action.enabled = this.servers.isOAuthAvailable;
		return root;
	}
	public setVisible(visible: boolean): void {
		if (!visible) this.controller.abort();
		else if (this.controller.signal.aborted) { this.controller = new AbortController(); if (this.action) this.action.enabled = this.servers.isOAuthAvailable; }
	}
}
