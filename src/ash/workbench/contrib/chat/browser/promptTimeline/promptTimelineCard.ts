import { localize } from '../../../../../nls.js';
import type { IPromptTimelineActions } from './promptTimelineRail.js';
import type { PromptTick } from './promptTimelineModel.js';

export function promptLabel(tick: PromptTick): string {
	return tick.prompt.text.replace(/\s+/gu, ' ').trim() || localize('chat.stickyScroll.emptyPrompt', 'User message');
}

export class PromptTimelineCard {
	private contentKey: string | undefined;
	constructor(private readonly container: HTMLElement, private readonly actions: IPromptTimelineActions) { }

	show(ticks: readonly PromptTick[]): void {
		const prompts = ticks.map(tick => ({ tick, files: this.actions.files(tick.prompt) }));
		const key = JSON.stringify(prompts.map(({ tick, files }) => [tick.prompt.id, tick.prompt.text, files.map(file => file.id)]));
		if (this.contentKey === key) return;
		this.contentKey = key;
		const document = this.container.ownerDocument;
		this.container.replaceChildren(...prompts.map(({ tick, files }) => {
			const row = document.createElement('div');
			row.className = 'ash-prompt-timeline-row';
			row.dataset.promptId = tick.prompt.id;
			const reveal = document.createElement('button');
			reveal.type = 'button';
			reveal.textContent = promptLabel(tick);
			reveal.title = reveal.textContent;
			reveal.onclick = () => this.actions.reveal(tick.prompt);
			row.append(reveal);
			if (files.length) {
				const changes = document.createElement('details');
				const label = document.createElement('summary');
				label.textContent = localize('chat.promptTimeline.files', 'Changed files ({0})', files.length);
				changes.append(label);
				for (const file of files) {
					const button = document.createElement('button');
					button.type = 'button';
					button.textContent = file.path;
					button.title = file.path;
					button.onclick = file.review;
					changes.append(button);
				}
				row.append(changes);
			}
			return row;
		}));
	}
}
