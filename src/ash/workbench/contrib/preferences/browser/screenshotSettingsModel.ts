import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import {
	IScreenshotService,
	ScreenshotGlobalShortcutSetting,
	type ScreenshotPermission
} from '../../screenshot/common/screenshot.js';
import type { SettingsSectionField, SettingsSectionModel } from './settingsTreeModels.js';

/** Presents local permission state and resolved shortcuts without persisting a second authority. */
export class ScreenshotSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'screenshot';
	readonly settingIds = [AccessibilityVerbositySettingId.ChatScreenshot, ScreenshotGlobalShortcutSetting];
	get title(): string {
		return localize('screenshot.settings.title', 'Screen capture');
	}
	get description(): string {
		return localize(
			'screenshot.settings.description',
			'Check permission for the application that is running and configure the screenshot shortcut.'
		);
	}
	get help(): string {
		return localize(
			'screenshot.settings.help',
			'Screenshot settings\nUse Tab to reach actions and Enter or Space to activate them. Refresh checks the current system permission. Open System Settings opens the macOS screen recording permission page. Show Application in Finder reveals the application to add if it is missing from that page. After granting access, restart the application if macOS asks. The shortcut shown here follows your Keyboard Shortcuts configuration. Choose Keyboard Shortcuts and search for Chat: Add Screenshot to change it. Enable Capture while Ash is in the background to register a global shortcut. Check shortcut availability tests the current combination; it cannot identify another application or guarantee future availability. A failed global replacement keeps the previous active shortcut shown here. Browser capture requests permission when you take a screenshot. Escape closes this help and returns focus.'
		);
	}
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private permission: ScreenshotPermission | undefined;
	private visible = false;
	private busy = false;
	private generation = 0;
	private message = '';

	constructor(
		@IScreenshotService private readonly screenshot: IScreenshotService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IPreferencesService private readonly preferences: IPreferencesService,
		@IHostService host: IHostService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICommandService private readonly commands: ICommandService
	) {
		super();
		this._register(keybindings.onDidUpdateKeybindings(() => this.changed.fire()));
		this._register(screenshot.onDidChangeShortcut(() => this.changed.fire()));
		this._register(
			configuration.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration(AccessibilityVerbositySettingId.ChatScreenshot) ||
					event.affectsConfiguration(ScreenshotGlobalShortcutSetting)
				)
					this.changed.fire();
			})
		);
		this._register(
			host.onDidChangeFocus((focused) => {
				if (focused && this.visible) void this.refresh();
			})
		);
	}

	get fields(): readonly SettingsSectionField[] {
		const permission = this.permission;
		const binding = this.keybindings.lookupKeybinding('workbench.action.chat.attachScreenshot');
		const shortcut = binding
			? getKeybindingLabel(binding)
			: localize('screenshot.settings.unassigned', 'Not assigned');
		return [
			{ id: 'permission', kind: 'status', text: this.message || this.permissionLabel() },
			{
				id: 'application',
				kind: 'status',
				text: permission?.applicationPath
					? localize(
						'screenshot.settings.application',
						'Current application: {0}',
						permission.applicationPath
					)
					: localize(
						'screenshot.settings.local',
						'Screen capture permission applies to this local application. Browser capture uses the browser permission prompt.'
					)
			},
			{
				id: 'shortcut',
				kind: 'status',
				text: localize('screenshot.settings.shortcut', 'Screenshot shortcut: {0}', shortcut)
			},
			{ id: 'availability', kind: 'status', text: this.shortcutLabel() },
			{
				id: 'global',
				kind: 'boolean',
				label: localize('screenshot.global.title', 'Capture while Ash is in the background'),
				value: this.configuration.getValue<boolean>(ScreenshotGlobalShortcutSetting) === true,
				enabled: permission !== undefined && permission.status !== 'browser',
				setValue: (value) => {
					void this.run(() =>
						this.configuration.updateValue(
							ScreenshotGlobalShortcutSetting,
							value,
							ConfigurationTarget.USER_LOCAL
						)
					);
				}
			},
			{
				id: 'checkShortcut',
				kind: 'action',
				label: localize('screenshot.shortcut.check', 'Check shortcut availability'),
				enabled: permission !== undefined && permission.status !== 'browser' && !this.busy,
				run: () => this.run(() => this.screenshot.checkShortcut())
			},
			{
				id: 'hints',
				kind: 'boolean',
				label: localize('chat.screenshot.verbosityTitle', 'Screenshot accessibility help'),
				value: this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatScreenshot) !== false,
				enabled: true,
				setValue: (value) => {
					void this.run(() =>
						this.configuration.updateValue(
							AccessibilityVerbositySettingId.ChatScreenshot,
							value,
							ConfigurationTarget.USER_LOCAL
						)
					);
				}
			},
			{
				id: 'refresh',
				kind: 'action',
				label: localize('screenshot.settings.refresh', 'Refresh permission'),
				enabled: !this.busy,
				run: () => this.refresh()
			},
			{
				id: 'settings',
				kind: 'action',
				label: localize('screenshot.permission.openSettings', 'Open System Settings'),
				enabled: permission?.canOpenSystemSettings === true && !this.busy,
				run: () => this.run(() => this.screenshot.openPermissionSettings())
			},
			{
				id: 'reveal',
				kind: 'action',
				label: localize('screenshot.permission.showApplication', 'Show Application in Finder'),
				enabled: permission?.canOpenSystemSettings === true && !this.busy,
				run: () => this.run(() => this.screenshot.revealApplication())
			},
			{
				id: 'keybindings',
				kind: 'action',
				label: localize('screenshot.settings.keybindings', 'Keyboard Shortcuts'),
				enabled: true,
				run: () =>
					this.run(async () => {
						await this.commands.executeCommand('workbench.action.closeActiveEditor');
						await this.preferences.openGlobalKeybindingSettings(false);
					})
			}
		];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.refresh();
		else {
			this.generation++;
			this.busy = false;
		}
	}

	private shortcutLabel(): string {
		const status = this.screenshot.shortcutStatus;
		switch (status.availability) {
			case 'unchecked':
				return localize('screenshot.shortcut.unchecked', 'Shortcut availability: Not checked.');
			case 'available':
				return status.global
					? localize(
						'screenshot.shortcut.registered',
						'Global screenshot shortcut active: {0}',
						status.activeLabel
					)
					: localize(
						'screenshot.shortcut.available',
						'The shortcut could be registered at the last check. It currently works only inside Ash.'
					);
			case 'unavailable':
				return (
					localize(
						'screenshot.shortcut.unavailable',
						'Shortcut unavailable. Another application, such as QQ, or the system may use it. The occupying application cannot be identified.'
					) +
					(status.activeLabel
						? ' ' +
						localize(
							'screenshot.shortcut.previous',
							'The previous global shortcut remains active: {0}',
							status.activeLabel
						)
						: '')
				);
			case 'unsupported':
				return this.permission?.status === 'browser'
					? localize(
						'screenshot.shortcut.browser',
						'System shortcut availability cannot be checked in the browser.'
					)
					: localize(
						'screenshot.shortcut.unsupported',
						'This key sequence cannot be registered as a global shortcut.'
					) + (status.activeLabel ? ' ' + localize('screenshot.shortcut.previous', 'The previous global shortcut remains active: {0}', status.activeLabel) : '');
			case 'unassigned':
				return localize('screenshot.shortcut.unassigned', 'No screenshot shortcut is assigned.');
			case 'unknown':
				return localize(
					'screenshot.shortcut.unknown',
					'Could not check shortcut availability. Check again before relying on it globally.'
				);
		}
	}

	private permissionLabel(): string {
		if (!this.permission || this.busy)
			return localize('screenshot.settings.checking', 'Checking screen capture permission…');
		switch (this.permission.status) {
			case 'granted':
				return localize('screenshot.settings.granted', 'Screen capture permission: Allowed');
			case 'denied':
				return localize(
					'screenshot.settings.denied',
					'Screen capture permission: Not allowed. Open System Settings to grant access.'
				);
			case 'restricted':
				return localize(
					'screenshot.settings.restricted',
					'Screen capture permission: Restricted by the system. Contact your administrator.'
				);
			case 'not-determined':
				return localize(
					'screenshot.settings.undetermined',
					'Screen capture permission: Not requested yet. Taking a screenshot will request access.'
				);
			case 'browser':
				return localize(
					'screenshot.settings.browser',
					'Screen capture permission: The browser asks you to choose a screen when you take a screenshot.'
				);
			case 'unknown':
				return localize(
					'screenshot.settings.unknown',
					'Screen capture permission: Status unavailable. Try taking a screenshot.'
				);
		}
	}

	private async refresh(): Promise<void> {
		if (this.busy || this.isDisposed || !this.visible) return;
		const generation = ++this.generation;
		this.busy = true;
		this.message = '';
		this.changed.fire();
		try {
			const [permission] = await Promise.all([this.screenshot.getPermission(), this.screenshot.checkShortcut()]);
			if (this.isDisposed || generation !== this.generation) return;
			this.permission = permission;
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			this.permission = undefined;
			this.message = localize(
				'screenshot.settings.failed',
				'Could not read screen capture permission: {0}',
				String(error)
			);
		} finally {
			if (!this.isDisposed && generation === this.generation) {
				this.busy = false;
				this.changed.fire();
			}
		}
	}

	private async run(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			if (!this.isDisposed) {
				this.message = localize(
					'screenshot.settings.actionFailed',
					'Could not open screen capture settings: {0}',
					String(error)
				);
				this.changed.fire();
			}
		}
	}
}
