import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Reviews the exact producer-declared feedback before its original policy decision. */
export class ChatAgentFeedbackReviewConfirmationSubPart extends AbstractToolConfirmationSubPart {
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>, private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'agentFeedbackReview'; }>) { super(document, resolve); }
	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		const root = h(this.domNode.ownerDocument, 'section');
		root.className = 'ash-chat-rich-tool-confirmation';
		const region = h(root.ownerDocument, 'pre');
		region.tabIndex = 0;
		region.setAttribute('role', 'region');
		region.setAttribute('aria-label', localize('chat.tool.feedbackReview', 'Feedback awaiting review'));
		region.textContent = this.presentation.message;
		root.append(h(root.ownerDocument, 'p', {}, request.reason), region);
		return root;
	}
}
