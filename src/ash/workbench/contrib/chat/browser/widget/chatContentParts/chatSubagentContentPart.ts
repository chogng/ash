import { h } from '../../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import type { ToolResultPresentation } from '../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import { chatSubagentStatusLabel } from '../../../common/model/chatSubagentActivity.js';
import { ChatSubagentOpenChat } from './chatSubagentOpenChat.js';
import './media/chatSubagentContent.css';

type SubagentActivity = NonNullable<IChatToolInvocation['subagentActivity']>;

/** Displays the child’s live Session projection and reuses the originating-host navigation. */
export class ChatSubagentContentPart extends Disposable {
	readonly domNode: HTMLElement;
	private readonly navigation: ChatSubagentOpenChat;
	private readonly status: HTMLElement;
	private readonly result: HTMLElement;

	constructor(document: Document, target: Extract<ToolResultPresentation, { type: 'sessionTarget'; }>, sourceSessionId: string,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.navigation = this._register(instantiation.createInstance(ChatSubagentOpenChat, document, target, sourceSessionId));
		this.status = h(document, 'div', { className: 'ash-chat-subagent-status', attributes: { role: 'status' } });
		this.result = h(document, 'p', { className: 'ash-chat-subagent-result' });
		this.domNode = h(document, 'div', { className: 'ash-chat-subagent-content' }, this.navigation.domNode, this.status, this.result);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	render(activity: SubagentActivity): boolean {
		const status = chatSubagentStatusLabel(activity);
		const result = activity.result?.summary ?? '';
		const changed = status !== this.status.textContent || result !== this.result.textContent;
		if (status !== this.status.textContent) this.status.textContent = status;
		if (result !== this.result.textContent) this.result.textContent = result;
		this.result.hidden = !result;
		return changed;
	}

	setVisible(visible: boolean): void {
		this.navigation.setVisible(visible);
	}
}
