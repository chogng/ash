import { h } from '../../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** Describes actual model argument deltas; incomplete arguments never carry execution authority. */
export class ChatToolStreamingSubPart extends BaseChatToolInvocationSubPart {
	constructor(document: Document) {
		super(h(document, 'p'));
		this.domNode.hidden = true;
	}
	public render(invocation: IChatToolInvocation): void {
		this.domNode.hidden = invocation.streaming !== true;
		if (invocation.streaming) this.domNode.textContent = localize('chat.tool.argumentProgress', 'Receiving tool arguments: {0} characters', invocation.call.argumentsJson.length);
	}
}
