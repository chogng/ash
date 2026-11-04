import './media/sessionsKeyboardShortcuts.css';
import { addDisposableListener, getActiveElement, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID } from '../../../common/sessionCommands.js';
import { filterSessionsKeyboardShortcutGroups, getSessionsKeyboardShortcutGroups } from './sessionsKeyboardShortcuts.js';

const resource = URI.parse('ash-preferences:/agent-window-keyboard-shortcuts');
const editorId = 'sessions.editor.keyboardShortcuts';
const title = () => localize2('sessions.shortcuts.title', 'Agent Window Keyboard Shortcuts');
const shortcutsFocused = new RawContextKey<boolean>('sessions.keyboardShortcutsFocused', false);
const verbosity = AccessibilityVerbositySettingId.SessionsKeyboardShortcuts;

class SessionsKeyboardShortcutsEditor extends EditorPane {
	readonly id = editorId;
	private readonly labels = this._register(new DisposableStore());
	private search!: InputBox;
	private results!: HTMLElement;
	private groups: ReturnType<typeof getSessionsKeyboardShortcutGroups> = [];

	constructor(
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(editorId, theme, storage);
	}

	override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		const root = h(document, 'div', { className: 'ash-sessions-keyboard-shortcuts' });
		const searchLabel = localize('sessions.shortcuts.search', 'Search Agent Window shortcuts');
		this.search = this._register(new InputBox(root, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search',
			presentation: 'field',
			ariaLabel: searchLabel,
			placeholder: localize('sessions.shortcuts.searchPlaceholder', 'Search by feature or key combination'),
		}));
		this.search.element.classList.add('ash-sessions-shortcut-search');
		const hint = this.accessibleView.getOpenAriaHint(verbosity);
		if (hint) this.search.inputElement.setAttribute('aria-description', hint);
		this.results = h(document, 'div', {
			className: 'ash-sessions-shortcut-results',
			properties: { tabIndex: 0 },
			attributes: { role: 'region', 'aria-label': title().value },
		});
		root.append(this.results);
		parent.append(root);
		super.create(root);
		shortcutsFocused.bindTo(this._register(this.contextKeys.createScoped(root))).set(true);
		this._register(this.search.onDidChange(() => {
			this.results.scrollTop = 0;
			const count = this.render();
			status(count === 1 ? localize('sessions.shortcuts.oneMatch', '1 matching shortcut') :
				localize('sessions.shortcuts.matchCount', '{0} matching shortcuts', count));
		}));
		this._register(addDisposableListener(this.search.inputElement, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && this.search.value) {
				stopEvent(event);
				this.search.value = '';
			}
		}));
		this._register(this.keybindings.onDidUpdateKeybindings(() => this.refresh()));
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		if (input.resource.toString() !== resource.toString()) throw new RangeError('Invalid Agent Window shortcuts resource');
		this.refresh();
	}

	override clearInput(): void {
		this.labels.clear();
		this.results?.replaceChildren();
		this.groups = [];
	}

	override focus(): void { this.search.focus(); }
	override layout(): void { /* The scroll region follows the modal's content box. */ }

	private refresh(): void {
		this.groups = getSessionsKeyboardShortcutGroups(this.keybindings, this.contextKeys);
		this.render();
	}

	private render(): number {
		this.labels.clear();
		this.results.replaceChildren();
		const document = this.results.ownerDocument;
		const groups = filterSessionsKeyboardShortcutGroups(this.groups, this.search.value, this.keybindings);
		let count = 0;
		for (const group of groups) {
			const list = h(document, 'ul', { className: 'ash-sessions-shortcut-list', attributes: { role: 'list' } });
			for (const { title, bindings } of group.shortcuts) {
				const row = h(document, 'li', { className: 'ash-sessions-shortcut-row' }, title);
				const keys = h(document, 'span', { className: 'ash-sessions-shortcut-keys' });
				for (const keybinding of bindings) {
					const label = this.labels.add(new KeybindingLabel(keys, { presentation: 'keycap', keybinding }));
					label.element.setAttribute('role', 'img');
				}
				row.append(keys);
				list.append(row);
			}
			const section = h(document, 'section', { className: 'ash-sessions-shortcut-group' });
			section.append(h(document, 'h3', { className: 'ash-sessions-shortcut-heading' }, group.title), list);
			this.results.append(section);
			count += group.shortcuts.length;
		}
		if (!count) {
			this.results.append(h(document, 'p', { className: 'ash-sessions-shortcut-empty' }, this.search.value.trim()
				? localize('sessions.shortcuts.noMatches', 'No Agent Window shortcuts match your search.')
				: localize('sessions.shortcuts.empty', 'No Agent Window shortcuts are assigned.')));
		}
		return count;
	}
}

registerEditorPane({
	id: editorId,
	name: title().value,
	canOpen: input => input.resource.toString() === resource.toString() ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(SessionsKeyboardShortcutsEditor),
});

registerAction2(class OpenSessionsKeyboardShortcuts extends Action2 {
	constructor() {
		super({ id: OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID, title: title(), icon: Lxicon.recordKeys, f1: true, precondition: IsSessionsWindowContext.isEqualTo(true) });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (!accessor.get(IContextKeyService).contextMatchesRules(IsSessionsWindowContext.isEqualTo(true))) return;
		await accessor.get(IEditorService).openEditor(
			{ resource, label: title().value, readOnly: true, showBreadcrumbs: false },
			{ pinned: true, ignoreError: true, modal: { size: { width: 960, height: 640 } } },
			'modalGroup',
		);
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
			() => localize('sessions.shortcuts.help', 'Type a feature name or a key combination to filter Agent Window shortcuts. Separate consecutive chords with a space. Use Tab to move to the results, then use screen reader heading and list navigation to read the grouped shortcuts. In the search field, Escape clears a query. Press Escape with an empty search to close the shortcut list.'),
			() => { if (isHTMLElement(focused)) focused.focus(); }, verbosity);
	},
});
