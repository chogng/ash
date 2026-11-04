import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { budgetBucketPrompts } from './promptBucketing.js';
import { PromptTimelineCard } from './promptTimelineCard.js';
import type { IPromptTimelineActions, IPromptTimelineRail } from './promptTimelineRail.js';
import type { PromptTick } from './promptTimelineModel.js';

export class PromptTimelineGutterRail extends Disposable implements IPromptTimelineRail {
	private readonly marks: HTMLSpanElement;
	private readonly panel: HTMLDivElement;
	private readonly card: PromptTimelineCard;
	private readonly rail: HTMLDetailsElement;
	private ticks: readonly PromptTick[] = [];
	private buckets: readonly (readonly PromptTick[])[] = [];
	private active: string | undefined;
	private pinned = false;
	private preview: HTMLElement | undefined;

	constructor(host: HTMLElement, actions: IPromptTimelineActions) {
		super();
		const document = host.ownerDocument;
		this.rail = document.createElement('details');
		this.rail.className = 'ash-prompt-timeline-gutter';
		const handle = document.createElement('summary');
		handle.setAttribute('aria-label', localize('chat.promptTimeline.show', 'Show prompts'));
		this.marks = document.createElement('span');
		this.marks.className = 'ash-prompt-timeline-gutter-marks';
		this.marks.setAttribute('aria-hidden', 'true');
		handle.append(this.marks);
		this.panel = document.createElement('div');
		this.panel.className = 'ash-prompt-timeline-panel';
		this.card = new PromptTimelineCard(this.panel, actions, () => this.close(), false);
		this.rail.append(handle, this.panel);
		handle.onclick = event => {
			event.preventDefault();
			if (this.pinned) {
				this.close();
				return;
			}
			this.pinned = true;
			this.open();
			const row = Array.from(this.panel.children).find(row => (row as HTMLElement).dataset.promptId === this.active)
				?? this.panel.firstElementChild;
			row?.querySelector('button')?.focus();
		};
		this.rail.onpointerenter = event => {
			if (event.pointerType === 'mouse') this.open();
		};
		this.rail.onpointerleave = () => {
			this.clearPreview();
			if (!this.pinned) this.close();
		};
		this.marks.onpointerleave = () => this.clearPreview();
		this._register(addDisposableListener(this.panel, 'focusin', () => { this.pinned = true; }));
		this._register(addDisposableListener<FocusEvent>(this.rail, 'focusout', event => {
			if (event.relatedTarget && !this.rail.contains(event.relatedTarget as Node)) this.close();
		}));
		this.rail.onkeydown = event => {
			if (event.key === 'Escape' && this.rail.open) {
				event.stopPropagation();
				handle.focus();
				this.close();
			}
		};
		this.panel.onkeydown = event => this.navigatePrompts(event);
		host.append(this.rail);
		this._register(toDisposable(() => this.rail.remove()));
	}

	private open(): void {
		if (this.rail.open) return;
		this.rail.open = true;
		this.card.show(this.ticks);
		this.setActive(this.active);
	}

	private close(): void {
		this.pinned = false;
		this.rail.open = false;
		this.clearPreview();
	}

	private clearPreview(): void {
		this.preview?.classList.remove('preview');
		this.preview = undefined;
	}

	private previewMark(index: number): void {
		const id = this.buckets[index][0].prompt.id;
		this.clearPreview();
		this.preview = Array.from(this.panel.children).find((row): row is HTMLElement =>
			(row as HTMLElement).dataset.promptId === id);
		if (!this.preview) return;
		this.preview.classList.add('preview');
		// Previewing a mark scrolls the flyout without moving the transcript.
		const row = this.preview.getBoundingClientRect();
		const panel = this.panel.getBoundingClientRect();
		if (row.top < panel.top) this.panel.scrollTop += row.top - panel.top;
		else if (row.bottom > panel.bottom) this.panel.scrollTop += row.bottom - panel.bottom;
	}

	private navigatePrompts(event: KeyboardEvent): void {
		const rows = Array.from(this.panel.children);
		const button = event.target as HTMLButtonElement;
		const index = rows.indexOf(button.parentElement!);
		if (index < 0) return;
		let next = index;
		let action = button.classList.contains('ash-prompt-timeline-review') ? 'review' : 'jump';
		switch (event.key) {
			case 'ArrowUp': next = Math.max(0, index - 1); break;
			case 'ArrowDown': next = Math.min(rows.length - 1, index + 1); break;
			case 'Home': next = 0; break;
			case 'End': next = rows.length - 1; break;
			case 'ArrowLeft': action = 'jump'; break;
			case 'ArrowRight': action = 'review'; break;
			default: return;
		}
		event.preventDefault();
		event.stopPropagation();
		const row = rows[next];
		(row.querySelector<HTMLButtonElement>(`.ash-prompt-timeline-${action}`) ?? row.querySelector('button'))?.focus();
	}

	render(ticks: readonly PromptTick[], height: number): void {
		this.ticks = ticks;
		this.rail.hidden = ticks.length < 2 || height < 24;
		if (this.rail.hidden) this.close();
		// Keep the handle compact in short panes. The flyout still lists every loaded prompt.
		this.buckets = budgetBucketPrompts(ticks, Math.min(24, Math.floor((height - 12) / 10)));
		if (this.marks.childElementCount !== this.buckets.length) {
			this.marks.replaceChildren(...this.buckets.map((_, index) => {
				const mark = this.rail.ownerDocument.createElement('span');
				mark.onpointerenter = event => {
					if (event.pointerType === 'mouse') this.previewMark(index);
				};
				return mark;
			}));
		}
		if (!this.rail.hidden && this.rail.open) this.card.show(ticks);
	}

	setActive(id: string | undefined): void {
		this.active = id;
		const markerId = id ?? this.ticks[0]?.prompt.id;
		for (const [index, mark] of Array.from(this.marks.children).entries()) {
			mark.classList.toggle('active', this.buckets[index].some(tick => tick.prompt.id === markerId));
		}
		for (const row of this.panel.children) {
			const button = row.firstElementChild!;
			if ((row as HTMLElement).dataset.promptId === id) button.setAttribute('aria-current', 'true');
			else button.removeAttribute('aria-current');
		}
	}
}
