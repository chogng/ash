import './searchDialog.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultDialogStyles, defaultListStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SessionsSearchModel, type SearchCategory, type SearchResult, type SearchTarget } from './searchModel.js';

/** Product search owns its DOM and presentation; Dialog, TabList and List supply interaction primitives. */
export class SessionsSearchDialog extends Disposable {
	private readonly dialog: Dialog;
	private readonly input: HTMLInputElement;
	private readonly model: SessionsSearchModel;
	private readonly results: List<SearchResult>;
	private readonly rowHovers = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private accepted: SearchTarget | undefined;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		const document = container.ownerDocument;
		this.model = this._register(instantiation.createInstance(SessionsSearchModel));
		const content = h(document, 'div', { className: 'ash-sessions-search' });
		this.dialog = this._register(new Dialog(container, { title: localize('sessions.search.title', 'Search'), content, dialogStyles: defaultDialogStyles }));
		this.dialog.element.classList.add('ash-sessions-search-dialog');
		this.dialog.element.setAttribute('aria-modal', 'true');
		const scope = this._register(contextKeys.createScoped(this.dialog.element));
		scope.createKey('sessionsSearchFocused', true);
		const header = h(document, 'header', { className: 'ash-sessions-search-header' });
		this.input = h(document, 'input');
		this.input.type = 'search';
		this.input.placeholder = localize('sessions.search.title', 'Search');
		this.input.setAttribute('role', 'combobox');
		this.input.setAttribute('aria-autocomplete', 'list');
		this.input.setAttribute('aria-expanded', 'true');
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsSearch);
		this.input.setAttribute('aria-label', hint ? localize('sessions.search.ariaLabel', 'Search. {0}', hint) : this.input.placeholder);
		header.append(this.input);
		this._register(new Button(header, { ...defaultButtonStyles, label: localize('sessions.search.close', 'Close'), icon: Lxicon.close, iconOnly: true, presentation: 'quiet', onClick: () => this.dialog.close() }));
		const navigation = h(document, 'div', { className: 'ash-sessions-search-tabs' });
		const tabs = this._register(new TabList<SearchCategory>(navigation, { ariaLabel: localize('sessions.search.categories', 'Search categories'), presentation: 'inset', onActivate: category => this.model.setCategory(category) }));
		tabs.setSizing({ mode: 'fit' });
		const body = h(document, 'section', { className: 'ash-sessions-search-body' });
		const heading = h(document, 'h2', { className: 'ash-sessions-search-heading' });
		const resultsHost = h(document, 'div', { className: 'ash-sessions-search-results' });
		this.results = this._register(new List<SearchResult>(resultsHost, {
			styles: { ...defaultListStyles, listActiveSelectionBackground: 'var(--ash-toolbar-hoverBackground)', listActiveSelectionForeground: 'var(--ash-foreground)' },
			ariaLabel: localize('sessions.search.results', 'Search results'), domFocusable: false, scrolling: 'managed',
			getId: result => result.id, getHeight: result => result.category === 'actions' ? 76 : 44,
			accessibilityProvider: { getAriaLabel: result => [result.title, result.description].filter(Boolean).join(', ') },
			onDidRemoveRow: row => this.rowHovers.deleteAndDispose(row),
			renderItem: (result, _index, listRow) => {
				this.rowHovers.deleteAndDispose(listRow);
				const hovers = this.rowHovers.set(listRow, new DisposableStore());
				listRow.classList.toggle('ash-sessions-search-action', result.category === 'actions');
				const row = h(document, 'div', { className: 'ash-sessions-search-result' });
				if (result.category === 'actions') { row.append(h(document, 'div', { className: 'ash-sessions-search-heading' }, localize('sessions.search.actions', 'Actions'))); }
				const line = h(document, 'div', { className: 'ash-sessions-search-result-line' });
				appendIcon(result.icon, line);
				const title = h(document, 'span', { className: 'ash-sessions-search-result-title' }, result.title);
				hovers.add(hoverService.setupDelayedHover(title, { content: result.title }));
				line.append(title);
				if (result.description) {
					const description = h(document, 'span', { className: 'ash-sessions-search-result-description' }, result.description);
					hovers.add(hoverService.setupDelayedHover(description, { content: result.description }));
					line.append(description);
				}
				line.append(h(document, 'span', { className: 'ash-sessions-search-result-open', attributes: { 'aria-hidden': 'true' } }, '↵'));
				row.append(line);
				return row;
			},
		}));
		resultsHost.id = `${this.results.element.id}-panel`;
		resultsHost.setAttribute('role', 'tabpanel');
		this.input.setAttribute('aria-controls', this.results.element.id);
		const message = h(document, 'div', { className: 'ash-sessions-search-empty', attributes: { role: 'status' } });
		body.append(heading, resultsHost, message);
		const footer = h(document, 'footer', { className: 'ash-sessions-search-footer' });
		for (const [label, key] of [[localize('sessions.search.close', 'Close'), 'Esc'], [localize('sessions.search.navigate', 'Navigate'), '↑ ↓'], [localize('sessions.search.open', 'Open'), '↵']]) {
			const item = h(document, 'span');
			item.append(label!, h(document, 'kbd', {}, key!));
			footer.append(item);
		}
		content.append(header, navigation, body, footer);
		const updateActive = (): void => {
			const row = this.results.row(this.results.activeIndex);
			if (row) { this.input.setAttribute('aria-activedescendant', row.id); }
			else { this.input.removeAttribute('aria-activedescendant'); }
		};
		this._register(this.results.onDidChangeActive(updateActive));
		this._register(this.results.onDidRenderRows(updateActive));
		this._register(this.results.onDidAccept(({ item }) => { this.accepted = item.target; this.dialog.close(); }));
		this._register(addDisposableListener(this.input, 'input', () => this.model.setQuery(this.input.value)));
		this._register(addDisposableListener(this.input, 'keydown', event => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault(); event.stopPropagation();
				if (event.key === 'ArrowDown') { this.results.focusNext(event); } else { this.results.focusPrevious(event); }
			} else if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault(); event.stopPropagation(); this.results.acceptActive(event);
			}
		}));
		this._register(addDisposableListener(navigation, 'keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); this.focus(); } }));
		this._register(addDisposableListener(this.dialog.element, 'keydown', event => {
			if (event.key === 'Escape' && !event.isComposing) {
				event.preventDefault(); event.stopPropagation(); this.dialog.close();
			}
		}, true));
		this._register(addDisposableListener(this.dialog.element, 'mousedown', event => {
			const bounds = this.dialog.element.getBoundingClientRect();
			if (event.target === this.dialog.element && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
				event.preventDefault(); this.dialog.close();
			}
		}));
		this._register(observeResize(resultsHost, () => this.results.layout(resultsHost.clientHeight)));
		this._register(autorun(reader => {
			const state = this.model.state.read(reader);
			const categories: readonly [SearchCategory, string][] = [
				['all', localize('sessions.search.all', 'All')],
				['sessions', localize('sessions.search.sessions', 'Sessions')],
				['projects', localize('sessions.search.projects', 'Projects')],
				['scheduled', localize('sessions.search.scheduled', 'Scheduled')],
			];
			tabs.setTabs(categories.map(([id, label]) => ({ id, value: id, label, tabId: `${this.results.element.id}-${id}`, panelId: resultsHost.id })), state.category);
			resultsHost.setAttribute('aria-labelledby', `${this.results.element.id}-${state.category}`);
			this.results.items = state.results;
			if (this.results.activeIndex < 0 && state.results.length) { this.results.setActiveIndex(0); }
			heading.textContent = state.query.trim() ? localize('sessions.search.results', 'Search results') : localize('sessions.search.recents', 'Recents');
			message.textContent = state.error ?? (state.loading ? localize('sessions.search.loading', 'Searching…') : localize('sessions.search.empty', 'No matching results'));
			message.hidden = !state.error && state.results.length > 0;
			body.setAttribute('aria-busy', String(state.loading));
		}));
	}

	async show(): Promise<SearchTarget | undefined> {
		const closed = this.dialog.show();
		this.focus();
		void this.model.refresh();
		await closed;
		return this.accepted;
	}

	focus(): void { this.input.focus(); }
}
