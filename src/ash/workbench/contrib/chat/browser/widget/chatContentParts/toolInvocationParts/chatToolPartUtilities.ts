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
export function getImageGenerationBatches(items: readonly IChatListItem[]): readonly (readonly IChatListItem[])[] {
	const batches: IChatListItem[][] = [];
	let batch: IChatListItem[] | undefined;
	let turnId: string | undefined;
	for (const item of items) {
		const invocation = item.toolInvocation;
		if (!invocation || !isImageGenerationToolInvocation(invocation)) {
			batch = undefined;
			continue;
		}
		if (!batch || turnId !== invocation.call.turnId) {
			batch = [];
			batches.push(batch);
			turnId = invocation.call.turnId;
		}
		batch.push(item);
	}
	return batches;
}
