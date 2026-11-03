import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { PromptTimelineCard } from './promptTimelineCard.js';
import type { IPromptTimelineActions, IPromptTimelineRail } from './promptTimelineRail.js';
import type { PromptTick } from './promptTimelineModel.js';

export class PromptTimelineGutterRail extends Disposable implements IPromptTimelineRail {
	private readonly panel: HTMLDivElement;
	private readonly card: PromptTimelineCard;
	private readonly rail: HTMLDetailsElement;
	private ticks: readonly PromptTick[] = [];
	private active: string | undefined;

	constructor(host: HTMLElement, actions: IPromptTimelineActions) {
		super();
		const document = host.ownerDocument;
		this.rail = document.createElement('details');
		this.rail.className = 'ash-prompt-timeline-gutter';
		const handle = document.createElement('summary');
		handle.textContent = '⋯';
		handle.setAttribute('aria-label', localize('chat.promptTimeline.show', 'Show prompts'));
		this.panel = document.createElement('div');
		this.panel.className = 'ash-prompt-timeline-panel';
		this.card = new PromptTimelineCard(this.panel, {
			...actions,
			reveal: prompt => { this.rail.open = false; actions.reveal(prompt); },
		});
		this.rail.append(handle, this.panel);
		this.rail.ontoggle = () => {
			if (this.rail.open) {
				this.card.show(this.ticks);
				this.setActive(this.active);
			}
		};
		this.rail.onkeydown = event => {
			if (event.key === 'Escape' && this.rail.open) {
				event.stopPropagation();
				this.rail.open = false;
				handle.focus();
			}
		};
		host.append(this.rail);
		this._register(toDisposable(() => this.rail.remove()));
	}

	render(ticks: readonly PromptTick[]): void {
		this.ticks = ticks;
		this.rail.hidden = ticks.length < 2;
		if (!this.rail.hidden && this.rail.open) this.card.show(ticks);
	}

	setActive(id: string | undefined): void {
		this.active = id;
		for (const row of this.panel.children) {
			const button = row.firstElementChild!;
			if ((row as HTMLElement).dataset.promptId === id) button.setAttribute('aria-current', 'true');
			else button.removeAttribute('aria-current');
		}
	}
}
