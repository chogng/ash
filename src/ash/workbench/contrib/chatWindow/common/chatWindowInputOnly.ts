const conversationHeight = 96;

/** Settled sash movement enters the compact view at its minimum. Moving back one keyboard step restores the chat. */
export function decideStackedChatInputOnly(size: number, composerSize: number, inputOnly: boolean): boolean {
	return size <= composerSize + (inputOnly ? 4 : 8);
}

export function stackedChatExpandedSize(composerSize: number, previousSize: number): number {
	return Math.max(previousSize, composerSize + conversationHeight);
}
