import { h } from '../../../../../base/browser/dom.js';
import type { ChatAgent } from '../../../../services/chat/common/chatService.js';
import './media/chatAgentHover.css';

/** Presents the selected Agent's domain metadata without keeping a second Agent catalog. */
export class ChatAgentHover {
	public readonly domNode: HTMLElement;
	private readonly name: HTMLElement;
	private readonly description: HTMLElement;

	constructor(document: Document) {
		this.domNode = h(document, 'section', { className: 'ash-chat-agent-hover' });
		this.name = h(document, 'h3', { className: 'ash-chat-agent-hover-name' });
		this.description = h(document, 'p', { className: 'ash-chat-agent-hover-description' });
		this.domNode.append(this.name, this.description);
	}

	public setAgent(agent: ChatAgent): void {
		this.name.textContent = agent.name;
		this.description.textContent = agent.description;
		this.description.hidden = !agent.description;
	}
}
