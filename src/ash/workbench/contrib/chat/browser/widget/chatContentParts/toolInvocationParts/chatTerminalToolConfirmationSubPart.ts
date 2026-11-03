import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';
import { ChatTerminalToolExplanation } from './chatTerminalToolExplanation.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../../../../base/common/uri.js';
import type { AgentResponse } from '../../../../../../../platform/agentHost/common/agent.js';

/** Shows the exact command and any captured sandbox attempt before authorizing execution. */
export class ChatTerminalToolConfirmationSubPart extends AbstractToolConfirmationSubPart {
	private explanation: ChatTerminalToolExplanation | undefined;
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>,
		private readonly explanationContext: { readonly resource: URI; readonly isCurrent: () => boolean; } | undefined,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(document, resolve);
	}

	protected override createContentElement(request: ActionApprovalRequest): HTMLElement {
		this.explanation = undefined;
		const document = this.domNode.ownerDocument;
		const content = h(document, 'div');
		content.className = 'ash-chat-terminal-confirmation';
		const reason = h(document, 'p');
		reason.textContent = request.reason;
		content.append(reason);
		if (request.command) {
			const command = h(document, 'pre');
			command.setAttribute('aria-label', localize('chat.approval.command', 'Command and arguments'));
			// JSON keeps argument boundaries and literal metacharacters visible, without suggesting shell quoting.
			command.textContent = `${request.command.program} ${JSON.stringify(request.command.arguments)}`;
			content.append(command);
			if (this.explanationContext) {
				const explanation = this.content.add(this.instantiation.createInstance(ChatTerminalToolExplanation, document, this.explanationContext, command.textContent));
				this.explanation = explanation;
				content.append(explanation.domNode);
			}
		}
		const denial = request.sandboxDenial;
		if (denial) {
			const heading = h(document, 'p');
			heading.textContent = localize('chat.approval.sandboxDenied', 'The sandbox blocked this attempt: {0}', denial.reason);
			const output = h(document, 'pre');
			output.setAttribute('aria-label', localize('chat.approval.previousOutput', 'Output from the blocked attempt'));
			output.textContent = denial.output.aggregatedOutput || denial.output.stdout + denial.output.stderr;
			output.hidden = !output.textContent;
			const status = h(document, 'p');
			status.textContent = denial.output.exitStatus.type === 'code'
				? localize('chat.approval.exitCode', 'Exit code: {0}', denial.output.exitStatus.code)
				: localize('chat.approval.terminated', 'The process was terminated.');
			content.append(heading, output, status);
		}
		return content;
	}

	public setVisible(visible: boolean): void {
		this.explanation?.setVisible(visible);
	}
}
