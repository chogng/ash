import './media/sessionsPreferences.css';
import '../../../../workbench/contrib/preferences/browser/media/settingsCard.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ContextView } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import '../../../../workbench/contrib/preferences/common/settingsEditorColorRegistry.js';
import { SettingsRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import type { ISetting } from '../../../../workbench/services/preferences/common/preferences.js';
import { SessionsConfiguration } from '../../../common/configuration.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Sessions Settings accessibility verbosity must be boolean');
		return value;
	},
});

function configuration<T>(key: string): IRegisteredConfiguration<T> {
	const registered = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key);
	if (!registered) throw new Error(`Sessions setting '${key}' is not registered`);
	return registered as IRegisteredConfiguration<T>;
}

interface SettingsCategory {
	readonly title: string;
	readonly icon: Icon;
	readonly settings: readonly ISetting[];
}

interface SettingsSection {
	readonly title: string;
	readonly categories: readonly SettingsCategory[];
}

/** Sessions owns its settings page while reusing the Workbench setting widgets. */
export class SessionsPreferences extends Disposable {
	private readonly activeDialog = this._register(new MutableDisposable<DisposableStore>());
	private dialog: Dialog | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly configurationService: IConfigurationService,
		private readonly clipboardService: IClipboardService,
		private readonly contextMenuProvider: IContextMenuProvider,
		private readonly contextKeys: IContextKeyService,
		private readonly accessibleView: IAccessibleViewService,
	) {
		super();
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: 'sessionsSettingsHelp',
			when: ContextKeyExpr.has('sessionsSettingsFocused'),
			getProvider: () => {
				const focused = this.container.ownerDocument.activeElement as HTMLElement;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsSettings,
					{ type: AccessibleViewType.Help },
					() => localize('sessions.settings.help', 'Sessions Settings has categories on the left and settings on the right. Use the search field to find a setting. Use Tab and Shift+Tab to move between controls, arrow keys to choose menu values, and Space to toggle switches. Press Escape to close Settings.'),
					() => focused.focus(),
					AccessibilityVerbositySettingId.SessionsSettings,
				);
			},
		}));
	}

	public async open(): Promise<void> {
		if (this.dialog?.element.open) {
			this.dialog.element.focus();
			return;
		}
		const ownerDocument = this.container.ownerDocument;
		const content = h(ownerDocument, 'div');
		content.className = 'ash-sessions-settings';
		const sidebar = h(ownerDocument, 'aside');
		sidebar.className = 'ash-sessions-settings-sidebar';
		const search = h(ownerDocument, 'div');
		search.className = 'ash-sessions-settings-search';
		search.setAttribute('role', 'search');
		appendIcon(Lxicon.search, search);
		const navigation = h(ownerDocument, 'nav');
		navigation.className = 'ash-sessions-settings-navigation';
		navigation.setAttribute('aria-label', localize('sessions.settings.categories', 'Settings categories'));
		sidebar.append(search, navigation);
		const page = h(ownerDocument, 'section');
		page.className = 'ash-sessions-settings-page';
		const heading = h(ownerDocument, 'h3');
		heading.className = 'ash-sessions-settings-page-title';
		heading.id = 'ash-sessions-settings-page-title';
		page.setAttribute('aria-labelledby', heading.id);
		const list = h(ownerDocument, 'div');
		list.className = 'ash-sessions-settings-list ash-settings-card';
		const empty = h(ownerDocument, 'p');
		empty.className = 'ash-sessions-settings-empty';
		empty.setAttribute('role', 'status');
		empty.textContent = localize('sessions.settings.noResults', 'No settings found.');
		const status = h(ownerDocument, 'p');
		status.className = 'ash-sessions-settings-status';
		status.setAttribute('role', 'status');
		status.hidden = true;
		page.append(heading, list, empty, status);
		content.append(sidebar, page);
		const resources = new DisposableStore();
		const searchInput = resources.add(new InputBox(search, {
			type: 'search',
			presentation: 'field',
			placeholder: localize('sessions.settings.search', 'Search settings'),
			ariaLabel: localize('sessions.settings.search', 'Search settings'),
		}));
		const dialog = resources.add(new Dialog(this.container, {
			title: localize('sessions.settings.title', 'Sessions Settings'),
			content,
		}));
		resources.add(addDisposableListener(dialog.element, 'click', event => {
			if (event.target === dialog.element) dialog.close();
		}));
		const contextView = resources.add(new ContextView(dialog.element));
		const renderer = resources.add(new SettingsRenderer(list, {
			clipboardService: this.clipboardService,
			configurationService: this.configurationService,
			contextMenuProvider: this.contextMenuProvider,
			contextViewProvider: contextView,
			onStatus: (message, isError) => {
				status.textContent = message;
				status.classList.toggle('is-error', isError);
				status.setAttribute('role', isError ? 'alert' : 'status');
				status.hidden = !message;
			},
		}));
		const sections = this.sections();
		const categories = sections.flatMap(section => section.categories);
		let activeCategory = 0;
		const buttons: Button[] = [];
		for (const section of sections) {
			const group = h(ownerDocument, 'div');
			group.className = 'ash-sessions-settings-navigation-group';
			group.setAttribute('role', 'group');
			group.setAttribute('aria-label', section.title);
			const label = h(ownerDocument, 'p');
			label.className = 'ash-sessions-settings-navigation-label';
			label.textContent = section.title;
			group.append(label);
			navigation.append(group);
			for (const category of section.categories) {
				const index = buttons.length;
				const button = resources.add(new Button(group, {
					label: category.title,
					icon: category.icon,
					presentation: 'quiet',
					onClick: () => {
						activeCategory = index;
						if (searchInput.value) searchInput.value = '';
						else render();
					},
				}));
				button.domNode.classList.add('ash-sessions-settings-navigation-item');
				buttons.push(button);
			}
		}
		const render = (): void => {
			const query = new SettingsSearchQuery(searchInput.value);
			const visible = query.isEmpty ? categories[activeCategory].settings : categories.flatMap(category => category.settings).filter(setting => query.matches(setting));
			heading.textContent = query.isEmpty ? categories[activeCategory].title : localize('sessions.settings.results', 'Search results');
			heading.hidden = query.isEmpty && visible.length === 0;
			list.replaceChildren(...visible.map(setting => renderer.render(setting)));
			page.scrollTop = 0;
			list.hidden = visible.length === 0;
			empty.hidden = query.isEmpty || visible.length !== 0;
			for (const [index, button] of buttons.entries()) {
				const isCurrent = query.isEmpty && index === activeCategory;
				button.toggleClassName('is-current', isCurrent);
				if (isCurrent) button.domNode.setAttribute('aria-current', 'page');
				else button.domNode.removeAttribute('aria-current');
			}
		};
		resources.add(searchInput.onDidChange(render));
		render();
		dialog.element.classList.add('ash-sessions-settings-dialog');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsSettings);
		if (hint) dialog.element.setAttribute('aria-description', hint);
		const scope = resources.add(this.contextKeys.createScoped(dialog.element));
		scope.createKey('sessionsSettingsFocused', true);
		this.dialog = dialog;
		this.activeDialog.value = resources;
		try {
			await dialog.show();
		} finally {
			this.dialog = undefined;
			this.activeDialog.clear();
		}
	}

	private sections(): readonly SettingsSection[] {
		const appearanceSettings: readonly ISetting[] = [{
			id: SessionsConfiguration.layoutStyle,
			valueType: 'select',
			configuration: configuration<string | boolean>(SessionsConfiguration.layoutStyle),
			title: localize('sessions.layoutStyle.title', 'Layout style'),
			description: localize('sessions.layoutStyle.description', 'Choose floating surfaces (Modern) or edge-to-edge regions (Flat).'),
			options: [
				{ value: 'modern', label: localize('sessions.layoutStyle.modern', 'Modern') },
				{ value: 'flat', label: localize('sessions.layoutStyle.flat', 'Flat') },
			],
		}, {
			id: SessionsConfiguration.activityBarLocation,
			valueType: 'select',
			configuration: configuration<string | boolean>(SessionsConfiguration.activityBarLocation),
			title: localize('sessions.activityBar.location.title', 'Activity Bar position'),
			description: localize('sessions.activityBar.location.description', 'Place the Activity Bar on the side, top, or bottom, or hide it.'),
			options: [
				{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
				{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
				{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
				{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
			],
		}, {
			id: SessionsConfiguration.activityBarCompact,
			valueType: 'boolean',
			configuration: configuration<boolean>(SessionsConfiguration.activityBarCompact),
			title: localize('sessions.activityBar.compact.title', 'Compact Activity Bar'),
				description: localize('sessions.activityBar.compact.description', 'Use smaller buttons when the Activity Bar is on the side.'),
		}];
		// Existing accessibility preferences live under General without changing their stored keys.
		const generalSettings: readonly ISetting[] = [{
			id: AccessibilityVerbositySettingId.SessionsActivityBar,
			valueType: 'boolean',
			configuration: configuration<boolean>(AccessibilityVerbositySettingId.SessionsActivityBar),
			title: localize('sessions.activity.verbosityTitle', 'Activity Bar accessibility help'),
			description: localize('sessions.activity.verbosityDescription', 'Announce how to open accessibility help when the Activity Bar receives focus.'),
		}, {
			id: AccessibilityVerbositySettingId.SessionsSettings,
			valueType: 'boolean',
			configuration: configuration<boolean>(AccessibilityVerbositySettingId.SessionsSettings),
			title: localize('sessions.settings.verbosityTitle', 'Settings accessibility help'),
			description: localize('sessions.settings.verbosityDescription', 'Announce how to open accessibility help when this page has focus.'),
		}];
		return [{
			title: localize('sessions.settings.section.basics', 'Basics'),
			categories: [
				{ title: localize('sessions.settings.general', 'General'), icon: Lxicon.settings, settings: generalSettings },
				{ title: localize('sessions.settings.account', 'Account'), icon: Lxicon.account, settings: [] },
				{ title: localize('sessions.settings.appearance', 'Appearance'), icon: Lxicon.appearance, settings: appearanceSettings },
				{ title: localize('sessions.settings.voice', 'Voice'), icon: Lxicon.mic, settings: [] },
				{ title: localize('sessions.settings.personalization', 'Personalization'), icon: Lxicon.customize, settings: [] },
			],
		}, {
			title: localize('sessions.settings.section.development', 'Development'),
			categories: [
				{ title: localize('sessions.settings.agents', 'Agents'), icon: Lxicon.agent, settings: [] },
				{ title: localize('sessions.settings.models', 'Models'), icon: Lxicon.model, settings: [] },
				{ title: localize('sessions.settings.gitPrs', 'Git & PRs'), icon: Lxicon.git, settings: [] },
				{ title: localize('sessions.settings.worktree', 'Worktree'), icon: Lxicon.gitBranch, settings: [] },
				{ title: localize('sessions.settings.browser', 'Browser'), icon: Lxicon.browserWeb, settings: [] },
				{ title: localize('sessions.settings.tab', 'Tab'), icon: Lxicon.splitPage, settings: [] },
				{ title: localize('sessions.settings.codeIntelligence', 'Code Intelligence'), icon: Lxicon.code, settings: [] },
				{ title: localize('sessions.settings.environment', 'Environment'), icon: Lxicon.terminal, settings: [] },
			],
		}, {
			title: localize('sessions.settings.section.management', 'Management'),
			categories: [
				{ title: localize('sessions.settings.plugins', 'Plugins'), icon: Lxicon.extensions, settings: [] },
				{ title: localize('sessions.settings.shortcuts', 'Keyboard Shortcuts'), icon: Lxicon.command, settings: [] },
				{ title: localize('sessions.settings.archivedChats', 'Archived Chats'), icon: Lxicon.archive, settings: [] },
			],
		}];
	}
}
