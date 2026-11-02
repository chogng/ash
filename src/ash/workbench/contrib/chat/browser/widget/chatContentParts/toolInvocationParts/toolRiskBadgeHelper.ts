import type { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import type { ActionApprovalRequest } from '../../../../../../../platform/agentHost/common/agent.js';
import { ToolRiskBadgeWidget } from './toolRiskBadgeWidget.js';

/** Missing review evidence stays absent; capabilities and tool names never imply a risk level. */
export function createApprovalReasonBadge(lifetime: DisposableStore, document: Document, request: ActionApprovalRequest): HTMLElement | undefined {
	if (!request.riskAssessment) {
		return undefined;
	}
	const badge = lifetime.add(new ToolRiskBadgeWidget(document));
	badge.setAssessment(request.riskAssessment);
	return badge.domNode;
}
