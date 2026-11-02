import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Dependency/remediation evidence accompanies the same capability-scoped execution approval. */
export class ChatSandboxPrerequisiteConfirmationSubPart extends AbstractToolConfirmationSubPart {
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>, private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'sandboxPrerequisite'; }>) { super(document, resolve); }
	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		const root = h(this.domNode.ownerDocument, 'section');
		root.className = 'ash-chat-rich-tool-confirmation';
		root.append(h(root.ownerDocument, 'p', {}, request.reason));
		for (const [entries, label] of [[this.presentation.dependencies, localize('chat.tool.sandboxDependencies', 'Required sandbox dependencies')], [this.presentation.remediations, localize('chat.tool.sandboxRemediations', 'Proposed sandbox remediation')]] as const) {
			if (!entries.length) continue;
			const list = h(root.ownerDocument, 'ul');
			list.setAttribute('aria-label', label);
			for (const entry of entries) list.append(h(root.ownerDocument, 'li', {}, entry));
			root.append(h(root.ownerDocument, 'p', {}, label), list);
		}
		return root;
	}
}
