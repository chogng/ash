import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IChatDebugService } from '../../common/chatDebugService.js';

/** Session discovery is an explicit catalog read, independent of capture recording. */
export class ChatDebugHomeView extends Disposable {
	readonly container: HTMLElement;
	private readonly navigate = this._register(new Emitter<URI>());
	readonly onNavigateToSession = this.navigate.event;
	private readonly rows = this._register(new DisposableStore());
	private readonly search: InputBox;
	private readonly list: HTMLElement;
	private readonly status: HTMLElement;
	private readonly scroll: ScrollableElement;
	private visible = false;
	private revision = 0;

	constructor(parent: HTMLElement, @IChatDebugService private readonly service: IChatDebugService) {
		super();
		const document = parent.ownerDocument;
		this.container = h(document, 'section', { className: 'ash-chat-debug-home' });
		this.container.hidden = true;
		this.container.setAttribute('aria-label', localize('chatDebug.sessions', 'Debug Sessions'));
		this.container.append(h(document, 'h2', localize('chatDebug.sessions', 'Debug Sessions')));
		this.search = this._register(new InputBox(this.container, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('chatDebug.searchSessions', 'Search Debug Sessions'),
			placeholder: localize('chatDebug.searchSessions', 'Search Debug Sessions'),
		}));
		this.status = h(document, 'p');
		this.status.setAttribute('aria-live', 'polite');
		this.container.append(this.status);
		this.list = h(document, 'div', { className: 'ash-chat-debug-session-list' });
		this.scroll = this._register(new ScrollableElement(this.container, { direction: 'vertical', tabIndex: -1 }));
		this.scroll.setContent(this.list);
		this.scroll.element.classList.add('ash-chat-debug-home-list');
		this.container.append(this.scroll.element);
		this._register(new Button(this.container, {
			...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.reloadSessions', 'Refresh Sessions'),
			onClick: () => { void this.refresh(); },
		}));
		this._register(this.search.onDidChange(() => this.render()));
		this._register(service.onDidChangeAvailableSessionResources(() => { if (this.visible) { this.render(); } }));
		parent.append(this.container);
		this._register(toDisposable(() => this.container.remove()));
	}

	show(): void {
		this.visible = true;
		this.container.hidden = false;
		this.render();
		void this.refresh();
	}

	hide(): void {
		this.visible = false;
		this.revision++;
		this.container.hidden = true;
	}

	focus(): void { this.search.focus(); }
	layout(): void { this.scroll.layout(); }
	getAccessibleContent(): string { return this.container.textContent ?? ''; }

	private async refresh(): Promise<void> {
		const revision = ++this.revision;
		this.status.textContent = localize('chatDebug.loadingSessions', 'Loading debug sessions…');
		try {
			await this.service.refreshAvailableSessions();
			if (revision === this.revision && !this.isDisposed && this.visible) { this.render(); }
		} catch (error) {
			if (revision === this.revision && !this.isDisposed && this.visible) {
				this.status.textContent = localize('chatDebug.sessionsFailed', 'Could not load debug sessions: {0}', String(error));
			}
		}
	}

	private render(): void {
		this.rows.clear();
		this.list.replaceChildren();
		const query = this.search.value.toLocaleLowerCase();
		const resources = this.service.getAvailableSessionResources().filter(resource => {
			const title = this.service.getHistoricalSessionTitle(resource) ?? '';
			return `${title} ${resource.path}`.toLocaleLowerCase().includes(query);
		});
		this.status.textContent = resources.length ? localize('chatDebug.sessionCount', '{0} sessions', resources.length) : localize('chatDebug.noSessions', 'No matching sessions. You can also import a saved trace from More Actions.');
		for (const resource of resources) {
			this.rows.add(new Button(this.list, {
				...defaultButtonStyles, presentation: 'secondary',
				label: this.service.getHistoricalSessionTitle(resource) || resource.path.slice(1),
				onClick: () => this.navigate.fire(resource),
			}));
		}
		this.scroll.layout();
	}
}
