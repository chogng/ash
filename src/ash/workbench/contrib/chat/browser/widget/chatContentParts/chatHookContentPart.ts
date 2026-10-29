import './media/chatHookContentPart.css';
import { h } from '../../../../../../base/browser/dom.js';
import { DomWidget } from '../../../../../../platform/domWidget/browser/domWidget.js';
import { localize } from '../../../../../../nls.js';
import type { IChatHookPart } from '../../../../../services/chat/common/chatService.js';

/** Collapsed Hook feedback in the conversation; the transcript owns its execution state. */
export class ChatHookContentPart extends DomWidget {
	public readonly domNode: HTMLDetailsElement;
	public get element(): HTMLElement {
		return this.domNode;
	}
	private readonly summary: HTMLElement;
	private readonly reason: HTMLElement;

	constructor(document: Document, hookPart: IChatHookPart) {
		super();
		this.domNode = h(document, 'details');
		this.domNode.className = 'ash-chat-hook';
		this.summary = h(document, 'summary');
		this.reason = h(document, 'p');
		this.domNode.append(this.summary, this.reason);
		this.render(hookPart);
	}

	/** Status changes keep the user's disclosure and focused summary in place. */
	public render(hookPart: IChatHookPart): void {
		const { run } = hookPart;
		const tool = run.toolName;
		switch (run.status.type) {
			case 'running':
				this.summary.textContent = tool ? localize('hooks.runningTool', 'Running {0} Hook for {1}', run.event, tool) : localize('hooks.running', 'Running {0} Hook', run.event);
				break;
			case 'continued':
				this.summary.textContent = tool ? localize('hooks.feedbackTool', 'Allowed {0} · {1} Hook', tool, run.event) : localize('hooks.feedback', 'Allowed by {0} Hook', run.event);
				break;
			case 'denied':
				this.summary.textContent = tool ? localize('hooks.blockedTool', 'Blocked {0} · {1} Hook', tool, run.event) : localize('hooks.blocked', 'Blocked by {0} Hook', run.event);
				break;
			case 'failed':
				this.summary.textContent = tool ? localize('hooks.failedTool', '{0} Hook failed for {1}', run.event, tool) : localize('hooks.failed', '{0} Hook failed', run.event);
				break;
			case 'cancelled':
				this.summary.textContent = tool ? localize('hooks.cancelledTool', '{0} Hook cancelled for {1}', run.event, tool) : localize('hooks.cancelled', '{0} Hook cancelled', run.event);
				break;
		}
		this.reason.textContent = run.status.type === 'denied' || run.status.type === 'cancelled' ? run.status.reason : run.status.type === 'failed' ? run.status.message : '';
		this.reason.hidden = !this.reason.textContent;
		this.domNode.dataset.runId = run.runId;
		this.domNode.dataset.status = run.status.type;
		if (run.turnId) this.domNode.dataset.turnId = run.turnId;
		else delete this.domNode.dataset.turnId;
		if (run.toolCallId) this.domNode.dataset.toolCallId = run.toolCallId;
		else delete this.domNode.dataset.toolCallId;
		this.domNode.setAttribute('aria-busy', String(run.status.type === 'running'));
	}
}
