import { getWindow, h } from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { formatTimeAgo } from '../../../../base/common/date.js';
import { Disposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { IHoverService } from '../../../../platform/hover/browser/hoverService.js';

export class ProjectListTimes extends Disposable {
	private readonly relativeTimeUpdate = this._register(new IntervalTimer());
	private readonly relativeTime = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'always' });

	constructor(private readonly hover: IHoverService, private readonly isVisible: () => boolean) {
		super();
	}

	reset(): void {
		this.relativeTimeUpdate.cancel();
	}

	render(button: HTMLButtonElement, timestamp: number, className: string, describe: (absoluteTime: string) => string, content: DisposableStore): HTMLTimeElement {
		const date = new Date(timestamp);
		const description = describe(date.toLocaleString(getNLSLanguage()));
		const caption = h(button.ownerDocument, 'time', {
			className,
			properties: { dateTime: date.toISOString(), id: generateUuid() },
			attributes: { 'aria-label': description },
		});
		button.setAttribute('aria-describedby', caption.id);
		content.add(this.hover.setupDelayedHover(caption, { content: description }));
		return caption;
	}

	update(list: HTMLElement): void {
		const captions = list.querySelectorAll<HTMLTimeElement>('time');
		if (!captions.length) return;
		const update = () => {
			const now = Date.now();
			// Refresh in place so time passing never interrupts keyboard focus.
			for (const caption of captions) {
				caption.textContent = formatTimeAgo(Date.parse(caption.dateTime), now, this.relativeTime)
					?? localize('projects.justNow', 'Just now');
			}
		};
		update();
		if (this.isVisible()) {
			this.relativeTimeUpdate.cancelAndSet(update, 60_000, getWindow(list));
		}
	}

}
