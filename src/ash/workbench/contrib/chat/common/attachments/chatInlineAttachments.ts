import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

/** Removes live producer labels and optionally detaches legacy image references when restoring a draft. */
export function projectChatDraftReferences(
	text: string,
	variables: readonly ChatContextAttachment[],
	detachImages = false,
): { text: string; contexts: readonly ChatContextAttachment[]; } {
	let contexts = variables.filter(attachment => attachment.lifetime !== 'source');
	for (const attachment of [...variables].reverse()) {
		const detached = detachImages && attachment.kind === 'image';
		if ((attachment.lifetime !== 'source' && !detached) || !attachment.reference) continue;
		const { start, end } = attachment.reference;
		text = text.slice(0, start) + text.slice(end);
		contexts = contexts.map(context => {
			if (detached && context.id === attachment.id) return { ...context, reference: undefined };
			const reference = context.reference;
			if (!reference || reference.start < end) return context;
			return { ...context, reference: { start: reference.start - (end - start), end: reference.end - (end - start) } };
		});
	}
	return { text, contexts };
}
