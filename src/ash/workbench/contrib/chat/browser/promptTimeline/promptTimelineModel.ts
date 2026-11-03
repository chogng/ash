import type { IChatListItem } from '../../common/model/chatViewModel.js';

export interface PromptFileDiff {
	readonly id: string;
	readonly path: string;
	readonly review: () => void;
}

export interface PromptTick {
	readonly prompt: IChatListItem;
	readonly position: number;
}

/** Derives navigation from the same rendered rows the transcript uses for reveal. */
export class PromptTimelineModel {
	constructor(
		readonly prompts: readonly IChatListItem[],
		private readonly getRow: (id: string) => HTMLElement,
	) { }

	firstPromptAfter(top: number): number {
		let low = 0;
		let high = this.prompts.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.getRow(this.prompts[middle].id).getBoundingClientRect().bottom <= top) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	bounds(prompt: IChatListItem): DOMRect {
		return this.getRow(prompt.id).getBoundingClientRect();
	}

	ticks(viewport: HTMLElement): PromptTick[] {
		const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
		return this.prompts.map(prompt => ({
			prompt,
			position: Math.min(1, Math.max(0, (this.bounds(prompt).top - origin) / Math.max(1, viewport.scrollHeight))),
		}));
	}
}
