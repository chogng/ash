import './media/sessionsPreferences.css';
import { h } from '../../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ContextView } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
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
import { PreferencesRenderer } from '../../../../workbench/contrib/preferences/browser/preferencesRenderers.js';
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
					() => localize('sessions.settings.help', 'Sessions Settings. Use Tab and Shift+Tab to move between settings. Use arrow keys to choose menu values, and Space to toggle switches. Press Escape to close Settings.'),
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
		const description = h(ownerDocument, 'p');
		description.className = 'ash-sessions-settings-description';
		description.textContent = localize('sessions.settings.description', 'Configure the Sessions window.');
		const list = h(ownerDocument, 'div');
		list.className = 'ash-sessions-settings-list';
		const status = h(ownerDocument, 'p');
		status.className = 'ash-sessions-settings-status';
		status.setAttribute('role', 'status');
		status.hidden = true;
		content.append(description, list, status);
		const resources = new DisposableStore();
		const dialog = resources.add(new Dialog(this.container, {
			title: localize('sessions.settings.title', 'Sessions Settings'),
			content,
			buttons: [{ label: localize('sessions.settings.close', 'Close'), value: 'close' }],
		}));
		const contextView = resources.add(new ContextView(dialog.element));
		const renderer = resources.add(new PreferencesRenderer(list, {
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
		for (const setting of this.settings()) list.append(renderer.render(setting));
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

	private settings(): readonly ISetting[] {
		return [
			{
				id: SessionsConfiguration.layoutStyle,
				valueType: 'select',
				configuration: configuration<string | boolean>(SessionsConfiguration.layoutStyle),
				title: localize('sessions.layoutStyle.title', 'Sessions layout style'),
				description: localize('sessions.layoutStyle.description', 'Choose floating Modern surfaces or edge-to-edge Flat regions in the Sessions window.'),
				options: [
					{ value: 'modern', label: localize('sessions.layoutStyle.modern', 'Modern') },
					{ value: 'flat', label: localize('sessions.layoutStyle.flat', 'Flat') },
				],
			},
			{
				id: SessionsConfiguration.activityBarLocation,
				valueType: 'select',
				configuration: configuration<string | boolean>(SessionsConfiguration.activityBarLocation),
				title: localize('sessions.activityBar.location.title', 'Sessions Activity Bar Position'),
				description: localize('sessions.activityBar.location.description', 'Choose where the Sessions Activity Bar appears.'),
				options: [
					{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
					{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
				],
			},
			{
				id: SessionsConfiguration.activityBarCompact,
				valueType: 'boolean',
				configuration: configuration<boolean>(SessionsConfiguration.activityBarCompact),
				title: localize('sessions.activityBar.compact.title', 'Compact Sessions Activity Bar'),
				description: localize('sessions.activityBar.compact.description', 'Use smaller buttons when the Sessions Activity Bar is on the side.'),
			},
			{
				id: AccessibilityVerbositySettingId.SessionsActivityBar,
				valueType: 'boolean',
				configuration: configuration<boolean>(AccessibilityVerbositySettingId.SessionsActivityBar),
				title: localize('sessions.activity.verbosityTitle', 'Sessions Activity Bar accessibility help'),
				description: localize('sessions.activity.verbosityDescription', 'Announce how to open accessibility help when the Sessions Activity Bar receives focus.'),
			},
			{
				id: AccessibilityVerbositySettingId.SessionsSettings,
				valueType: 'boolean',
				configuration: configuration<boolean>(AccessibilityVerbositySettingId.SessionsSettings),
				title: localize('sessions.settings.verbosityTitle', 'Sessions Settings accessibility help'),
				description: localize('sessions.settings.verbosityDescription', 'Announce how to open accessibility help when Sessions Settings has focus.'),
			},
		];
	}
}
