import './media/sessionsKeyboardShortcuts.css';
import { addDisposableListener, getActiveElement, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createServiceIdentifier, IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { SessionsSearchDialog } from '../../../browser/ui/sessionsSearchDialog.js';
import { OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID } from '../../../common/sessionCommands.js';
import { filterSessionsKeyboardShortcutGroups, getSessionsKeyboardShortcutGroups, type ShortcutArea } from './sessionsKeyboardShortcuts.js';

const title = () => localize2('sessions.shortcuts.title', 'Agent Window Keyboard Shortcuts');
const shortcutsFocused = new RawContextKey<boolean>('sessions.keyboardShortcutsFocused', false);
const verbosity = AccessibilityVerbositySettingId.SessionsKeyboardShortcuts;
type Category = 'all' | ShortcutArea;

const categoryLabels = (): Record<Category, string> => ({
	all: localize('sessions.search.all', 'All'),
	general: localize('sessions.shortcuts.general', 'General'),
	browser: localize('sessions.shortcuts.browser', 'Browser'),
	debug: localize('sessions.shortcuts.debug', 'Debug'),
	diff: localize('sessions.shortcuts.diff', 'Diff'),
	apps: localize('sessions.shortcuts.apps', 'Apps'),
	agent: localize('sessions.shortcuts.agent', 'Agent'),
});

class SessionsKeyboardShortcutsDialog extends Disposable {
	private readonly labels = this._register(new DisposableStore());
	private readonly dialog: SessionsSearchDialog;
	private readonly categories: TabList<Category>;
	private readonly panel: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly results: HTMLElement;
	private category: Category = 'all';
	private groups: ReturnType<typeof getSessionsKeyboardShortcutGroups> = [];

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		const content = h(document, 'div');
		this.dialog = this._register(new SessionsSearchDialog(container, content, {
			title: title().value,
			ariaLabel: localize('sessions.shortcuts.search', 'Search Agent Window shortcuts'),
			placeholder: localize('sessions.shortcuts.searchPlaceholder', 'Search by feature or key combination'),
			className: 'ash-sessions-shortcuts-dialog',
		}));
		const search = this.dialog.input;
		const hint = accessibleView.getOpenAriaHint(verbosity);
		if (hint) search.setAttribute('aria-description', hint);
		const updateResults = () => {
			this.scrollable.scrollTo(0, 0);
			const count = this.render();
			status(count === 1 ? localize('sessions.shortcuts.oneMatch', '1 matching shortcut') :
				localize('sessions.shortcuts.matchCount', '{0} matching shortcuts', count));
		};
		const navigation = h(document, 'div', { className: 'ash-sessions-search-categories' });
		this.categories = this._register(new TabList<Category>(navigation, {
			ariaLabel: localize('sessions.shortcuts.categories', 'Shortcut categories'),
			presentation: 'navigation',
			onActivate: category => {
				if (this.category === category) return;
				this.category = category;
				this.updateCategories();
				updateResults();
			},
		}));
		this.panel = h(document, 'section', {
			className: 'ash-sessions-shortcut-panel',
			attributes: { role: 'tabpanel' },
		});
		this.scrollable = this._register(new ScrollableElement(this.panel, {
			direction: 'vertical',
			ariaLabel: title().value,
		}));
		this.panel.id = `${this.scrollable.scrollableElement.id}-panel`;
		this.results = h(document, 'div', { className: 'ash-sessions-shortcut-results' });
		this.scrollable.contentElement.append(this.results);
		content.append(navigation, this.panel);
		shortcutsFocused.bindTo(this._register(contextKeys.createScoped(content))).set(true);
		this._register(addDisposableListener(navigation, 'keydown', event => {
			if (event.key === 'ArrowDown') {
				stopEvent(event);
				this.focus();
			}
		}));
		this._register(addDisposableListener(search, 'input', updateResults));
		this._register(addDisposableListener(search, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && search.value) {
				stopEvent(event);
				search.value = '';
				updateResults();
			}
		}));
		this._register(keybindings.onDidUpdateKeybindings(() => this.refresh()));
		this.refresh();
	}

	async show(): Promise<void> { await this.dialog.show(); }
	focus(): void { this.dialog.input.focus(); }

	private refresh(): void {
		this.groups = getSessionsKeyboardShortcutGroups(this.keybindings, this.contextKeys);
		if (this.category !== 'all' && !this.groups.some(group => group.area === this.category)) {
			this.category = 'all';
			this.scrollable.scrollTo(0, 0);
		}
		this.updateCategories();
		this.render();
	}

	private updateCategories(): void {
		const labels = categoryLabels();
		const available = new Set<Category>(['all', ...this.groups.map(group => group.area)]);
		const tabId = (category: Category) => `${this.panel.id}-${category}`;
		this.categories.setTabs((Object.keys(labels) as Category[]).filter(category => available.has(category)).map(category => ({
			id: category, value: category, label: labels[category], tabId: tabId(category), panelId: this.panel.id,
		})), this.category);
		this.panel.setAttribute('aria-labelledby', tabId(this.category));
	}

	private render(): number {
		this.labels.clear();
		this.results.replaceChildren();
		const document = this.results.ownerDocument;
		const scope = this.category === 'all' ? this.groups : this.groups.filter(group => group.area === this.category);
		const groups = filterSessionsKeyboardShortcutGroups(scope, this.dialog.input.value, this.keybindings);
		const categoryNames = categoryLabels();
		const createList = () => h(document, 'ul', { className: 'ash-sessions-shortcut-list', attributes: { role: 'list' } });
		const flatList = this.category !== 'all' && groups.length ? createList() : undefined;
		if (flatList) this.results.append(flatList);
		let count = 0;
		for (const group of groups) {
			const list = flatList ?? createList();
			for (const { title, bindings } of group.shortcuts) {
				const separator = title.search(/[:：]/u);
				const prefix = separator < 0 ? '' : title.slice(0, separator).trimEnd();
				const name = prefix === group.title || prefix === categoryNames[group.area] ? title.slice(separator + 1).trimStart() : title;
				const row = h(document, 'li', { className: 'ash-sessions-shortcut-row' }, name);
				const keys = h(document, 'span', { className: 'ash-sessions-shortcut-keys' });
				for (const keybinding of bindings) {
					const label = this.labels.add(new KeybindingLabel(keys, { presentation: 'keycap', keybinding }));
					label.element.setAttribute('role', 'img');
				}
				row.append(keys);
				list.append(row);
			}
			if (!flatList) {
				const section = h(document, 'section', { className: 'ash-sessions-shortcut-group' });
				section.append(h(document, 'h3', { className: 'ash-sessions-shortcut-heading' }, group.title), list);
				this.results.append(section);
			}
			count += group.shortcuts.length;
		}
		if (!count) {
			this.results.append(h(document, 'p', { className: 'ash-sessions-shortcut-empty' }, this.dialog.input.value.trim()
				? localize('sessions.shortcuts.noMatches', 'No Agent Window shortcuts match your search.')
				: localize('sessions.shortcuts.empty', 'No Agent Window shortcuts are assigned.')));
		}
		return count;
	}
}

interface ISessionsKeyboardShortcutsService {
	show(): Promise<void>;
}

const ISessionsKeyboardShortcutsService = createServiceIdentifier<ISessionsKeyboardShortcutsService>('sessionsKeyboardShortcutsService');

class SessionsKeyboardShortcutsService extends Disposable implements ISessionsKeyboardShortcutsService {
	private readonly active = this._register(new MutableDisposable<SessionsKeyboardShortcutsDialog>());

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILayoutService private readonly layout: ILayoutService,
	) { super(); }

	async show(): Promise<void> {
		if (this.active.value) { this.active.value.focus(); return; }
		const dialog = this.instantiation.createInstance(SessionsKeyboardShortcutsDialog, this.layout.activeContainer);
		this.active.value = dialog;
		try { await dialog.show(); }
		finally { this.active.clear(); }
	}
}

registerSingleton(ISessionsKeyboardShortcutsService, SessionsKeyboardShortcutsService, InstantiationType.Delayed);

registerAction2(class OpenSessionsKeyboardShortcuts extends Action2 {
	constructor() {
		super({ id: OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID, title: title(), icon: Lxicon.recordKeys, f1: true, precondition: IsSessionsWindowContext.isEqualTo(true) });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (!accessor.get(IContextKeyService).contextMatchesRules(IsSessionsWindowContext.isEqualTo(true))) return;
		await accessor.get(ISessionsKeyboardShortcutsService).show();
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: verbosity,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Agent Window shortcuts accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('sessions.shortcuts.verbosityTitle', 'Agent Window Keyboard Shortcuts Accessibility Help'); },
		get description() { return localize('sessions.shortcuts.verbosityDescription', 'Announce how to open accessibility help when the Agent Window shortcut list has focus.'); },
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'sessionsKeyboardShortcutsHelp',
	when: shortcutsFocused.isEqualTo(true),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument);
		return new AccessibleContentProvider(AccessibleViewProviderId.SessionsKeyboardShortcuts, { type: AccessibleViewType.Help },
			() => localize('sessions.shortcuts.help', 'Type a feature name or a key combination to filter shortcuts in the selected category. Separate consecutive chords with a space. Select All to search every category and see results grouped by feature. Use Tab to reach Close, the category tabs, and the results. On the tabs, use Left and Right to move, Enter or Space to select, and Down to return to search. Use screen reader list navigation to read the shortcuts. In the search field, Escape clears a query. Press Escape with an empty search to close the shortcut list.'),
			() => { if (isHTMLElement(focused)) focused.focus(); }, verbosity);
	},
});
