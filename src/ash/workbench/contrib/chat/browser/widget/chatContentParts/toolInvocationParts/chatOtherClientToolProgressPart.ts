import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import type { AgentResponse, DynamicToolCall } from '../../../../../../../platform/agentHost/common/agent.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** A reply to the original client-tool offer; it cannot execute or select a replacement tool. */
export class ChatOtherClientToolProgressPart extends BaseChatToolInvocationSubPart {
	constructor(document: Document, call: DynamicToolCall, resolve: (response: AgentResponse) => Promise<void>) {
		super(h(document, 'section'));
		this.domNode.className = 'ash-chat-rich-tool-confirmation';
		const message = h(document, 'p');
		message.textContent = localize('chat.tool.otherClient', 'Waiting for the connected client to run {0}.', call.name);
		const argumentsNode = h(document, 'pre');
		argumentsNode.textContent = JSON.stringify(call.arguments, null, 2);
		argumentsNode.tabIndex = 0;
		argumentsNode.setAttribute('role', 'region');
		argumentsNode.setAttribute('aria-label', localize('chat.tool.otherClientArguments', 'Client tool arguments'));
		this.domNode.append(message, argumentsNode);
		this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('chat.tool.skipClient', 'Skip this tool'),
			onClick: () => { void resolve({ type: 'dynamicTool', response: { callId: call.callId, success: false, content: [{ type: 'text', text: localize('chat.tool.clientSkipped', 'The user skipped this client tool call.') }] } }).catch(() => undefined); },
		}));
	}
}
