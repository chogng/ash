import { h } from '../../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** A compact result for a completed, parameterless call with no streams or resource payload. */
export class ChatSimpleToolProgressPart extends BaseChatToolInvocationSubPart<HTMLPreElement> {
	constructor(document: Document) {
		super(h(document, 'pre'));
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'region');
		this.domNode.hidden = true;
	}

	public render(invocation: IChatToolInvocation): boolean {
		const { call, result, output } = invocation;
		const selected = !!result && call.argumentsJson.trim() === '{}' && !output.length
			&& call.binding?.activity?.type !== 'command' && !(result.content?.length);
		this.domNode.hidden = !selected;
		if (selected) {
			this.domNode.setAttribute('aria-label', result.isError ? localize('chat.tool.error', 'Error') : localize('chat.tool.result', 'Result'));
			this.domNode.textContent = result.text;
		}
		return selected;
	}
}
