import { h } from '../../../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ActionApprovalRiskAssessment } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import './media/toolRiskBadge.css';

/** Shows a policy-bound advisory assessment without granting or inferring execution authority. */
export class ToolRiskBadgeWidget extends Disposable {
	/** Stable mount root. The native disclosure owns expansion and keyboard focus. */
	public readonly domNode: HTMLDetailsElement;
	private readonly summary: HTMLElement;
	private readonly explanation: HTMLElement;

	constructor(document: Document) {
		super();
		this.domNode = h(document, 'details');
		this.domNode.className = 'ash-tool-risk-badge';
		this.summary = h(document, 'summary');
		this.explanation = h(document, 'p');
		this.domNode.append(this.summary, this.explanation);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public setAssessment(assessment: ActionApprovalRiskAssessment): void {
		const labels = {
			low: localize('chat.toolRisk.low', 'Low risk'),
			medium: localize('chat.toolRisk.medium', 'Medium risk'),
			high: localize('chat.toolRisk.high', 'High risk'),
			critical: localize('chat.toolRisk.critical', 'Critical risk'),
		};
		this.summary.textContent = labels[assessment.riskLevel];
		this.explanation.textContent = assessment.reason;
		this.domNode.classList.toggle('high', assessment.riskLevel === 'high');
		this.domNode.classList.toggle('critical', assessment.riskLevel === 'critical');
	}
}
