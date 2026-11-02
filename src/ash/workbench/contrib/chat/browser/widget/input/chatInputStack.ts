import './media/chatInputStack.css';

/** The input host keeps DOM order; the stack owns spacing and adjoining frames. */
export const chatInputStackClass = 'ash-chat-input-stack';
export const chatInputStackSlotClass = 'ash-chat-input-stack-slot';

export const enum ChatInputStackSlot {
	Empty,
	/** Joins the next visible surface. */
	Docked,
	/** Keeps its own bottom edge and separates the next surface. */
	Standalone,
}

const dockedClass = 'ash-chat-input-stack-docked';
const standaloneClass = 'ash-chat-input-stack-standalone';
const continuesClass = 'ash-chat-input-stack-continues';
const spacedClass = 'ash-chat-input-stack-spaced';
const focusedClass = 'ash-chat-input-stack-input-focused';

/** Producers report their existing visibility; no content or business state is retained here. */
export function setChatInputStackSlot(slot: HTMLElement | null | undefined, state: ChatInputStackSlot): void {
	if (!slot) return;
	slot.classList.toggle(dockedClass, state === ChatInputStackSlot.Docked);
	slot.classList.toggle(standaloneClass, state === ChatInputStackSlot.Standalone);
	refreshChatInputStack(slot.parentElement?.closest<HTMLElement>(`.${chatInputStackClass}`));
}

export function isChatInputStackSlotShowing(slot: HTMLElement): boolean {
	return slot.classList.contains(dockedClass) || slot.classList.contains(standaloneClass);
}

/** Report focus explicitly so streamed content does not invalidate a subtree-wide focus selector. */
export function setChatInputStackInputFocused(input: HTMLElement, focused: boolean): void {
	input.closest(`.${chatInputStackClass}`)?.classList.toggle(focusedClass, focused);
}

/** Hosts call this after inserting or removing members; producers call it when their visibility changes. */
export function refreshChatInputStack(stack: HTMLElement | null | undefined): void {
	if (!stack?.classList.contains(chatInputStackClass)) return;
	const slots = Array.from(stack.children).filter((child): child is HTMLElement => child.classList.contains(chatInputStackSlotClass));
	const showing = slots.filter(isChatInputStackSlotShowing);
	for (const slot of slots) {
		const index = showing.indexOf(slot);
		const previous = showing[index - 1];
		const adjoining = previous?.classList.contains(dockedClass) ?? false;
		slot.classList.toggle(continuesClass, adjoining);
		slot.classList.toggle(spacedClass, index > 0 && !adjoining);
	}
}
