import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';

/** Image generation is declared by the native tool or its resolved MCP binding. */
export function isImageGenerationToolInvocation(invocation: IChatToolInvocation): boolean {
	const call = invocation.call;
	return call.name === 'imagegen' || call.binding?.sourceChain.some(source => source.type === 'mcp' && source.remoteName === 'imagegen') === true;
}

/** Waiting for interaction is distinct from actively generating an image. */
export function isImageGenerationToolInProgress(invocation: IChatToolInvocation): boolean {
	return isImageGenerationToolInvocation(invocation) && !invocation.result && !invocation.stopped && !invocation.waitingFor;
}

/** A gallery cannot cross another message, a non-image tool, or a Turn boundary. */
export function getImageGenerationBatch(content: readonly IChatListItem[], toolCallId: string, turnId: string): IChatListItem[] {
	const owner = content.findIndex(item => item.toolInvocation?.call.toolCallId === toolCallId && item.toolInvocation.call.turnId === turnId);
	const belongs = (index: number): boolean => {
		const invocation = content[index]?.toolInvocation;
		return !!invocation && invocation.call.turnId === turnId && isImageGenerationToolInvocation(invocation);
	};
	if (owner < 0 || !belongs(owner)) {
		return [];
	}
	let start = owner;
	let end = owner + 1;
	while (belongs(start - 1)) {
		start--;
	}
	while (belongs(end)) {
		end++;
	}
	return content.slice(start, end);
}
