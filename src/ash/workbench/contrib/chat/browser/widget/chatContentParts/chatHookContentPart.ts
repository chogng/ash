import './media/chatHookContentPart.css';
import { h } from '../../../../../../base/browser/dom.js';
import { DomWidget } from '../../../../../../platform/domWidget/browser/domWidget.js';
import { localize } from '../../../../../../nls.js';
import type { IChatHookPart } from '../../../../../services/chat/common/chatService.js';

/** Collapsed Hook feedback in the conversation; the transcript owns its execution state. */
export class ChatHookContentPart extends DomWidget {
	public readonly domNode: HTMLDetailsElement;
	public get element(): HTMLElement { return this.domNode; }

	constructor(document: Document, hookPart: IChatHookPart) {
		super();
		this.domNode = h(document, 'details');
		this.domNode.className = 'ash-chat-hook';
		const summary = h(document, 'summary');
		summary.textContent = hookPart.stopReason
			? hookPart.toolDisplayName
				? localize('hooks.blockedTool', 'Blocked {0} · {1} Hook', hookPart.toolDisplayName, hookPart.hookType)
				: localize('hooks.blocked', 'Blocked by {0} Hook', hookPart.hookType)
			: hookPart.toolDisplayName
				? localize('hooks.feedbackTool', 'Hook feedback for {0} · {1}', hookPart.toolDisplayName, hookPart.hookType)
				: localize('hooks.feedback', 'Hook feedback · {0}', hookPart.hookType);
		const reason = h(document, 'p');
		reason.textContent = [hookPart.stopReason, hookPart.systemMessage].filter(Boolean).join('\n');
		this.domNode.append(summary, reason);
	}
}
