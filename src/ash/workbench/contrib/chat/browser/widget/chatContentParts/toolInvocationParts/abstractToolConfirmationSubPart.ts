import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { h } from '../../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ActionApprovalDecision, ActionApprovalRequest, AgentResponse } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { createApprovalReasonBadge } from './toolRiskBadgeHelper.js';

/** Owns approval actions and their lifetime; the input owner retains dispatch authority. */
export abstract class AbstractToolConfirmationSubPart extends Disposable {
	public readonly domNode: HTMLElement;
	protected readonly content = this._register(new DisposableStore());

	constructor(document: Document, private readonly resolve: (response: AgentResponse) => Promise<void>) {
		super();
		this.domNode = h(document, 'div');
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public render(request: ActionApprovalRequest): void {
		this.content.clear();
		this.domNode.replaceChildren();
		const content = this.createContentElement(request);
		const risk = createApprovalReasonBadge(this.content, this.domNode.ownerDocument, request);
		if (risk) {
			this.domNode.append(risk);
		}
		const capabilities = h(this.domNode.ownerDocument, 'ul');
		capabilities.className = 'ash-chat-approval-capabilities';
		capabilities.setAttribute('aria-label', localize('chat.approval.targets', 'Requested actions and targets'));
		const labels = {
			fileRead: localize('chat.approval.fileRead', 'Read file'),
			fileWrite: localize('chat.approval.fileWrite', 'Write file'),
			processSpawn: localize('chat.approval.processSpawn', 'Run command'),
			network: localize('chat.approval.network', 'Access network'),
			credentialUse: localize('chat.approval.credentialUse', 'Use credential'),
			externalMutation: localize('chat.approval.externalMutation', 'Change external resource'),
			systemConfiguration: localize('chat.approval.systemConfiguration', 'Change system settings'),
			userInterface: localize('chat.approval.userInterface', 'Control user interface'),
		};
		for (const capability of request.capabilities) {
			const item = h(this.domNode.ownerDocument, 'li');
			const label = h(this.domNode.ownerDocument, 'span');
			label.textContent = labels[capability.kind];
			const scope = h(this.domNode.ownerDocument, 'code');
			// The backend owns scope syntax: paths, commands and domains must remain exact.
			scope.textContent = capability.scope;
			item.append(label, this.domNode.ownerDocument.createTextNode(': '), scope);
			capabilities.append(item);
		}
		const actions = h(this.domNode.ownerDocument, 'div');
		actions.className = 'ash-chat-interaction-actions';
		const decisions = request.allowedDecisions ?? ['approveOnce', 'decline'];
		if (decisions.includes('decline')) {
			this.addDecision(actions, localize('chat.approval.decline', 'Decline'), 'decline');
		}
		if (decisions.includes('approveOnce')) {
			const label = request.sandboxDenial?.replaySafety === 'safeToRetry'
				? localize('chat.approval.retryOnce', 'Approve retry once')
				: localize('chat.approval.approveOnce', 'Approve once');
			this.addDecision(actions, label, 'approveOnce', 'primary');
		}
		for (const choice of decisions) {
			switch (choice) {
				case 'approveForSession':
					this.addDecision(actions, localize('chat.approval.approveForSession', 'Approve same action this session'), choice);
					break;
				case 'approveFileWriteForSession':
					this.addDecision(actions, localize('chat.approval.approveFileWriteForSession', 'Allow edits to this file this session'), choice);
					break;
				case 'approveCommandPrefixForSession':
					if (request.sessionCommandPrefix) {
						const prefix = request.sessionCommandPrefix;
						const command = [prefix.program, ...prefix.arguments].join(' ');
						this.addDecision(actions, localize('chat.approval.approveCommandPrefixForSession', 'Allow the {0} prefix this session', command), choice);
					}
					break;
				case 'approveAndSaveRule':
					this.addDecision(actions, localize('chat.approval.saveRule', 'Save approval for this exact action'), choice);
					break;
			}
		}
		this.domNode.append(content, capabilities, actions);
	}

	protected abstract createContentElement(request: ActionApprovalRequest): HTMLElement;

	private addDecision(container: HTMLElement, label: string, decision: ActionApprovalDecision, presentation: 'primary' | 'secondary' = 'secondary'): void {
		const button = this.content.add(new Button(container, {
			...defaultButtonStyles, label, presentation,
			onClick: () => { void this.resolve({ type: 'approval', response: { decision } }).catch(() => undefined); },
		}));
		button.domNode.classList.add(presentation === 'primary' ? 'ash-chat-send-button' : 'ash-chat-secondary-button');
	}
}
