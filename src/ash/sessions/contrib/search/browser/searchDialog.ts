import './searchDialog.css';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import { SegmentedControl } from '../../../../base/browser/ui/segmentedControl/segmentedControl.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Keybinding, logicalKey, resolveKeybinding, ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { localize } from '../../../../nls.js';
import {
	defaultButtonStyles, defaultDialogStyles, defaultListStyles, defaultCheckboxStyles,
	defaultInputBoxStyles, defaultKeybindingLabelStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SessionsSearchModel, type SearchCategory, type SearchResult, type SearchTarget } from './searchModel.js';

/** Product search owns its DOM and presentation; shared controls supply interaction primitives. */
export class SessionsSearchDialog extends Disposable {
	private readonly dialog: Dialog;
	private readonly input: HTMLInputElement;
	private readonly model: SessionsSearchModel;
	private readonly results: List<SearchResult>;
	private readonly rowHovers = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private accepted: SearchTarget | undefined;

	constructor(
		container: HTMLElement,
		sourceResults: IObservable<readonly SearchResult[]>,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		const document = container.ownerDocument;
		this.model = this._register(instantiation.createInstance(SessionsSearchModel, sourceResults));
		const content = h(document, 'div', { className: 'ash-sessions-search' });
		this.dialog = this._register(new Dialog(container, localize('sessions.search.title', 'Search'), [], {
			buttonStyles: defaultButtonStyles,
			checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: defaultDialogStyles,
			extraClasses: ['ash-sessions-search-dialog'],
			disableCloseButton: true,
			disableDefaultAction: true,
			renderBody: body => body.append(content),
		}));
		const scope = this._register(contextKeys.createScoped(content));
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
		this._register(new Button(header, { ...defaultButtonStyles, label: localize('sessions.search.close', 'Close'), icon: Lxicon.close, iconOnly: true, presentation: 'quiet', onClick: () => this.dialog.dispose() }));
		const navigation = h(document, 'div', { className: 'ash-sessions-search-categories' });
		const categories = this._register(new SegmentedControl<SearchCategory>(navigation, {
			ariaLabel: localize('sessions.search.categories', 'Search categories'),
			items: [
				{ id: 'all', label: localize('sessions.search.all', 'All') },
				{ id: 'sessions', label: localize('sessions.search.sessions', 'Sessions') },
				{ id: 'projects', label: localize('sessions.search.projects', 'Projects') },
				{ id: 'scheduled', label: localize('sessions.search.scheduled', 'Scheduled') },
			],
			selectedId: 'all', onActivate: category => this.model.setCategory(category),
		}));
		const body = h(document, 'section', { className: 'ash-sessions-search-body' });
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
		this.input.setAttribute('aria-controls', this.results.element.id);
		const message = h(document, 'div', { className: 'ash-sessions-search-empty', attributes: { role: 'status' } });
		body.append(resultsHost, message);
		const footer = h(document, 'footer', { className: 'ash-sessions-search-footer' });
		const hints = [
			{ label: localize('sessions.search.close', 'Close'), keys: [{ key: 'Escape', label: 'Esc' }] },
			{ label: localize('sessions.search.navigate', 'Navigate'), keys: [{ key: 'ArrowUp', label: '↑' }, { key: 'ArrowDown', label: '↓' }] },
			{ label: localize('sessions.search.open', 'Open'), keys: [{ key: 'Enter', label: '↵' }] },
		];
		for (const { label, keys } of hints) {
			const item = h(document, 'span');
			const shortcuts = h(document, 'span', { className: 'ash-sessions-search-shortcuts' });
			for (const { key, label: symbol } of keys) {
				const keybinding = resolveKeybinding(Keybinding.single(logicalKey(key)));
				const shortcut = this._register(new KeybindingLabel(shortcuts, {
					...defaultKeybindingLabelStyles, presentation: 'keycap',
					keybinding: new ResolvedKeybinding(
						keybinding.chords.map(chord => ({ ...chord, label: symbol })), keybinding.operatingSystem,
					),
				}));
				// Keep the spoken key name independent of the compact visual symbol.
				shortcut.element.setAttribute('aria-label', getKeybindingLabel(keybinding, KeybindingLabelStyle.Aria));
			}
			item.append(label, shortcuts);
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
		this._register(this.results.onDidAccept(({ item }) => { this.accepted = item.target; this.dialog.dispose(); }));
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
		this._register(addDisposableListener(getWindow(content), 'mousedown', event => {
			const target = event.target as HTMLElement | null;
			if (!target?.classList?.contains('ash-sessions-search-dialog')) return;
			const bounds = target.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
				event.preventDefault();
				this.dialog.dispose();
			}
		}, true));
		this._register(observeResize(resultsHost, () => this.results.layout(resultsHost.clientHeight)));
		this._register(autorun(reader => {
			const state = this.model.state.read(reader);
			categories.setSelection(state.category);
			this.results.items = state.results;
			if (this.results.activeIndex < 0 && state.results.length) { this.results.setActiveIndex(0); }
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
