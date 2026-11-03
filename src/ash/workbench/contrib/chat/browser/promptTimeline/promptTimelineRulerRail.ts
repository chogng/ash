import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { budgetBucketPrompts } from './promptBucketing.js';
import { PromptTimelineCard, promptLabel } from './promptTimelineCard.js';
import { spaceMarkCenters } from './promptTimelineLayout.js';
import type { PromptTick } from './promptTimelineModel.js';
import type { IPromptTimelineActions, IPromptTimelineRail } from './promptTimelineRail.js';

const markGap = 24;

export class PromptTimelineRulerRail extends Disposable implements IPromptTimelineRail {
	private readonly rail: HTMLDivElement;
	private readonly marks: HTMLDivElement;
	private readonly panel: HTMLDivElement;
	private readonly card: PromptTimelineCard;
	private openMark: HTMLButtonElement | undefined;
	private buckets: readonly (readonly PromptTick[])[] = [];

	constructor(host: HTMLElement, actions: IPromptTimelineActions) {
		super();
		const document = host.ownerDocument;
		this.rail = document.createElement('div');
		this.rail.className = 'ash-prompt-timeline-ruler';
		this.rail.setAttribute('role', 'group');
		this.rail.setAttribute('aria-label', localize('chat.promptTimeline.show', 'Show prompts'));
		this.marks = document.createElement('div');
		this.panel = document.createElement('div');
		this.panel.className = 'ash-prompt-timeline-panel';
		this.panel.hidden = true;
		this.card = new PromptTimelineCard(this.panel, {
			...actions,
			reveal: prompt => { this.close(); actions.reveal(prompt); },
		});
		this.rail.append(this.marks, this.panel);
		this.rail.onkeydown = event => {
			if (event.key === 'Escape' && this.openMark) {
				event.stopPropagation();
				this.openMark.focus();
				this.close();
			}
		};
		host.append(this.rail);
		this._register(toDisposable(() => this.rail.remove()));
	}

	private close(): void {
		this.openMark?.setAttribute('aria-expanded', 'false');
		this.openMark = undefined;
		this.panel.hidden = true;
	}

	render(ticks: readonly PromptTick[], height: number): void {
		this.rail.hidden = ticks.length < 2 || height < markGap;
		const buckets = budgetBucketPrompts(ticks, Math.min(24, Math.floor(height / markGap)));
		const centers = spaceMarkCenters(buckets.map(bucket => bucket[0].position), height, markGap);
		const structureChanged = buckets.length !== this.buckets.length || buckets.some((bucket, index) =>
			bucket.length !== this.buckets[index].length || bucket.some((tick, item) => tick.prompt.id !== this.buckets[index][item].prompt.id));
		this.buckets = buckets;
		if (structureChanged) {
			this.close();
			this.marks.replaceChildren(...buckets.map((_, index) => {
				const mark = this.rail.ownerDocument.createElement('button');
				mark.type = 'button';
				mark.className = 'ash-prompt-timeline-mark';
				mark.textContent = '•';
				mark.setAttribute('aria-expanded', 'false');
				mark.onclick = () => {
					const wasOpen = this.openMark === mark;
					this.close();
					if (wasOpen) return;
					this.openMark = mark;
					this.card.show(this.buckets[index]);
					this.panel.hidden = false;
					mark.setAttribute('aria-expanded', 'true');
					this.panel.querySelector('button')?.focus();
				};
				return mark;
			}));
		}
		for (const [index, mark] of Array.from(this.marks.children).entries()) {
			const bucket = buckets[index];
			if (mark === this.openMark) this.card.show(bucket);
			const label = bucket.length === 1 ? promptLabel(bucket[0]) : localize('chat.promptTimeline.group', '{0} prompts starting with {1}', bucket.length, promptLabel(bucket[0]));
			(mark as HTMLButtonElement).style.top = `${centers[index]}px`;
			mark.setAttribute('aria-label', label);
			(mark as HTMLButtonElement).title = label;
		}
	}

	setActive(id: string | undefined): void {
		for (const [index, mark] of Array.from(this.marks.children).entries()) {
			if (this.buckets[index].some(tick => tick.prompt.id === id)) mark.setAttribute('aria-current', 'true');
			else mark.removeAttribute('aria-current');
		}
	}
}
