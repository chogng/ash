import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest } from '../../../../../../../platform/agentHost/common/agent.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Presents an ordinary capability approval without interpreting backend-authored text. */
export class ToolConfirmationSubPart extends AbstractToolConfirmationSubPart {
	protected override createContentElement(request: ActionApprovalRequest): HTMLElement {
		const reason = h(this.domNode.ownerDocument, 'p');
		reason.textContent = request.reason;
		return reason;
	}
}
