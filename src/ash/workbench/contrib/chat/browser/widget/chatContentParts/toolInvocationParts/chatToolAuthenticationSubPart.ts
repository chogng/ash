import '../media/chatMcpServersInteractionContent.css';
import { h } from '../../../../../../../base/browser/dom.js';
import { isCancellationError } from '../../../../../../../base/common/errors.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { localize } from '../../../../../../../nls.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { IMcpServerManagementService } from '../../../../../../../platform/mcp/common/mcpServerManagementService.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Runs sign-in on the conversation's MCP host without resolving the pending approval. */
export class ChatToolAuthenticationSubPart extends AbstractToolConfirmationSubPart {
	private controller = new AbortController();
	private action: Button | undefined;
	private section: HTMLElement | undefined;
	private feedback: HTMLElement | undefined;
	private signedIn = false;

	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>,
		private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'authentication'; }>, private readonly serverId: string,
		@IMcpServerManagementService private readonly servers: IMcpServerManagementService,
	) {
		super(document, resolve);
		this._register(toDisposable(() => this.controller.abort()));
	}

	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		this.controller.abort();
		this.controller = new AbortController();
		this.signedIn = false;
		const root = this.section = h(this.domNode.ownerDocument, 'section', { className: 'ash-chat-mcp-authentication' });
		const feedback = this.feedback = h(root.ownerDocument, 'div', { className: 'ash-chat-mcp-authentication-feedback', attributes: { role: 'status' } });
		root.append(h(root.ownerDocument, 'p', {}, request.reason));
		const action = this.action = this.content.add(new Button(root, {
			...defaultButtonStyles,
			label: localize('chat.tool.signInProvider', 'Sign in to {0}', this.presentation.provider),
			onClick: () => {
				if (this.controller.signal.aborted || !this.domNode.isConnected || !action.enabled) return;
				const signal = this.controller.signal;
				action.enabled = false;
				feedback.textContent = localize('chat.tool.authPending', 'Waiting for sign-in…');
				root.setAttribute('aria-busy', 'true');
				void this.servers.login(this.serverId, undefined, signal).then(() => {
					if (signal.aborted) return;
					this.signedIn = true;
					feedback.textContent = localize('chat.tool.authReady', 'Sign-in completed. Review the tool approval to continue.');
				}, error => {
					if (signal.aborted) return;
					feedback.textContent = isCancellationError(error) ? '' : localize('chat.tool.authFailed', 'Sign-in failed. {0}', String(error));
				}).finally(() => {
					if (!this.isDisposed && signal === this.controller.signal && !signal.aborted) {
						root.removeAttribute('aria-busy');
						action.enabled = !this.signedIn && this.servers.isOAuthAvailable;
					}
				});
			},
		}));
		root.append(feedback);
		action.enabled = this.servers.isOAuthAvailable;
		return root;
	}

	public setVisible(visible: boolean): void {
		if (!visible) {
			this.controller.abort();
			this.section?.removeAttribute('aria-busy');
			if (this.feedback && !this.signedIn) this.feedback.textContent = '';
		} else if (this.controller.signal.aborted) {
			this.controller = new AbortController();
			if (this.action) this.action.enabled = !this.signedIn && this.servers.isOAuthAvailable;
		}
	}
}
