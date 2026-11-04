import { localize } from '../../../../../nls.js';
import { getChangesStatsFilesLabel } from '../../../../browser/changesStatsWidget.js';
import type { IPromptTimelineActions } from './promptTimelineRail.js';
import type { PromptTick } from './promptTimelineModel.js';

export function promptLabel(tick: PromptTick): string {
	return tick.prompt.text.replace(/\s+/gu, ' ').trim() || localize('chat.stickyScroll.emptyPrompt', 'User message');
}

export class PromptTimelineCard {
	private contentKey: string | undefined;
	constructor(
		private readonly container: HTMLElement,
		private readonly actions: IPromptTimelineActions,
		private readonly close: () => void,
		private readonly showFiles: boolean,
	) { }

	show(ticks: readonly PromptTick[]): void {
		const prompts = ticks.map(tick => ({ tick, changes: this.actions.changes?.(tick.prompt.id) }));
		const key = JSON.stringify(prompts.map(({ tick, changes }) => [
			tick.prompt.id, tick.prompt.text, changes?.files, changes?.insertions, changes?.deletions,
			this.showFiles ? changes?.fileDiffs.map(file => file.id) : undefined,
		]));
		if (this.contentKey === key) return;
		this.contentKey = key;
		const document = this.container.ownerDocument;
		const focused = document.activeElement;
		const focusedRow = focused?.parentElement;
		const focusedPrompt = focusedRow?.parentElement === this.container ? focusedRow.dataset.promptId : undefined;
		this.container.replaceChildren(...prompts.map(({ tick, changes }) => {
			const row = document.createElement('div');
			row.className = 'ash-prompt-timeline-row';
			row.dataset.promptId = tick.prompt.id;
			const reveal = document.createElement('button');
			reveal.type = 'button';
			reveal.className = 'ash-prompt-timeline-jump';
			reveal.textContent = promptLabel(tick);
			reveal.title = reveal.textContent;
			reveal.onclick = () => { this.close(); this.actions.reveal(tick.prompt.id); };
			row.append(reveal);
			if (changes) {
				const review = document.createElement('button');
				review.type = 'button';
				review.className = 'ash-prompt-timeline-review ash-changes-stats';
				const label = localize('chat.promptTimeline.reviewTurn', 'View turn changes for {0}: {1}, {2} lines added, {3} lines deleted',
					reveal.textContent, getChangesStatsFilesLabel(changes.files), changes.insertions, changes.deletions);
				review.setAttribute('aria-label', label);
				review.title = localize('chat.promptTimeline.reviewTurnTitle', 'View turn changes');
				const added = document.createElement('span');
				added.className = 'ash-changes-stats-added';
				added.textContent = `+${changes.insertions}`;
				const removed = document.createElement('span');
				removed.className = 'ash-changes-stats-removed';
				removed.textContent = `−${changes.deletions}`;
				review.append(added, document.createTextNode(' '), removed);
				review.onclick = () => { this.close(); void this.actions.changes?.(tick.prompt.id)?.review(); };
				row.append(review);
			}
			const files = this.showFiles ? changes?.fileDiffs ?? [] : [];
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
					button.onclick = () => {
						this.close();
						this.actions.changes?.(tick.prompt.id)?.fileDiffs.find(candidate => candidate.id === file.id)?.review();
					};
					changes.append(button);
				}
				row.append(changes);
			}
			return row;
		}));
		// Live capture statistics can refresh while a keyboard user is on the review action.
		if (focusedPrompt !== undefined) {
			const row = Array.from(this.container.children).find(row => (row as HTMLElement).dataset.promptId === focusedPrompt);
			const review = focused?.classList.contains('ash-prompt-timeline-review') ? row?.querySelector<HTMLButtonElement>('.ash-prompt-timeline-review') : undefined;
			(review ?? row?.querySelector('button'))?.focus({ preventScroll: true });
		}
	}
}
