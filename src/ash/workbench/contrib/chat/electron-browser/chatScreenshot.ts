import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { toElectronAccelerator } from '../../../../platform/keybinding/common/electronAccelerator.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import {
	GLOBAL_KEYBINDING_UPDATE_CHANNEL,
	GLOBAL_KEYBINDING_TRIGGER_CHANNEL,
	validateGlobalKeybindingResult,
} from '../../../../platform/globalKeybindings/common/globalKeybindings.js';
import { invoke, subscribe } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IImageEditorService } from '../../../services/imageEditor/common/imageEditorService.js';
import { ScreenshotCommandId, ScreenshotGlobalShortcutSetting } from '../common/constants.js';
import { localize } from '../../../../nls.js';

interface ScreenshotShortcutStatus {
	readonly availability: 'unchecked' | 'available' | 'unavailable' | 'unsupported' | 'unassigned' | 'unknown';
	readonly global: boolean;
	readonly activeLabel: string;
}

/** Chat owns its screenshot command, legacy preference and conflict notices; the platform owns OS leases. */
export class ChatScreenshotContribution extends Disposable {
	private readonly warning = this._register(new MutableDisposable());
	private warningMessage = '';
	private shortcut: ScreenshotShortcutStatus = { availability: 'unchecked', global: false, activeLabel: '' };
	private pendingShortcut: Promise<void> = Promise.resolve();
	private shortcutGeneration = 0;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@ICommandService commands: ICommandService,
		@ILogService log: ILogService,
		@IImageEditorService private readonly editors: IImageEditorService,
		@INotificationService private readonly notifications: INotificationService,
		@IPreferencesService private readonly preferences: IPreferencesService,
	) {
		super();
		this._register(
			editors.onDidChange(() => {
				void this.checkShortcut();
			}),
		);
		this._register(
			keybindings.onDidUpdateKeybindings(() => {
				void this.checkShortcut();
			}),
		);
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(ScreenshotGlobalShortcutSetting)) void this.checkShortcut();
			}),
		);
		const trigger = subscribe<unknown>(GLOBAL_KEYBINDING_TRIGGER_CHANNEL, value => {
			if (
				!value ||
				typeof value !== 'object' ||
				Array.isArray(value) ||
				Object.keys(value).join(',') !== 'id' ||
				typeof (value as { id?: unknown }).id !== 'string'
			)
				throw new TypeError('Invalid global keybinding trigger');
			if ((value as { id: string }).id === 'chat.screenshot')
				void commands
					.executeCommand(ScreenshotCommandId)
					.catch(error => log.error('Could not start screenshot from global shortcut', error));
		});
		this._register(
			toDisposable(() => {
				trigger.dispose();
				void invoke(GLOBAL_KEYBINDING_UPDATE_CHANNEL, {
					id: 'chat.screenshot',
					commandId: ScreenshotCommandId,
					accelerator: '',
					label: '',
					global: false,
				}).catch(() => {});
			}),
		);
		void this.checkShortcut();
	}

	public checkShortcut(): Promise<void> {
		const generation = ++this.shortcutGeneration;
		const operation = this.pendingShortcut.then(async () => {
			if (this.isDisposed || generation !== this.shortcutGeneration) return;
			const binding = this.keybindings.lookupKeybinding(ScreenshotCommandId);
			const accelerator = toElectronAccelerator(binding);
			const global =
				this.configuration.getValue<boolean>(ScreenshotGlobalShortcutSetting) === true &&
				this.editors.available;
			try {
				const result = validateGlobalKeybindingResult(
					await invoke<unknown>(GLOBAL_KEYBINDING_UPDATE_CHANNEL, {
						id: 'chat.screenshot',
						commandId: ScreenshotCommandId,
						accelerator: accelerator ?? '',
						label: binding ? getKeybindingLabel(binding) : '',
						global: global && !!binding,
					}),
				);
				if (this.isDisposed || generation !== this.shortcutGeneration) return;
				this.shortcut = {
					global,
					availability: !binding
						? 'unassigned'
						: !accelerator
							? 'unsupported'
							: result.available
								? 'available'
								: 'unavailable',
					activeLabel: result.activeLabel,
				};
			} catch (error) {
				if (this.isDisposed || generation !== this.shortcutGeneration) return;
				this.shortcut = { global, availability: 'unknown', activeLabel: '' };
			}
			this.updateWarning();
		});
		this.pendingShortcut = operation.catch(() => {});
		return operation;
	}

	private updateWarning(): void {
		const status = this.shortcut;
		let message = '';
		if (status.global) {
			switch (status.availability) {
				case 'unavailable':
					message = localize(
						'screenshot.shortcut.conflictNotice',
						'The global screenshot shortcut could not be registered. Another application or the system may use it.',
					);
					break;
				case 'unsupported':
					message = localize(
						'screenshot.shortcut.unsupportedNotice',
						'This screenshot shortcut cannot be used globally. Choose another key combination.',
					);
					break;
				case 'unassigned':
					message = localize(
						'screenshot.shortcut.unassignedNotice',
						'Assign a screenshot shortcut to use global screenshots.',
					);
					break;
				case 'unknown':
					message = localize(
						'screenshot.shortcut.failedNotice',
						'Could not enable the global screenshot shortcut. Try changing the shortcut.',
					);
					break;
			}
		}
		if (message && status.activeLabel) {
			message +=
				' ' +
				localize(
					'screenshot.shortcut.previousActive',
					'The previous shortcut still works: {0}.',
					status.activeLabel,
				);
		}
		// Dismissed failures stay quiet until the state changes; a changed retained
		// shortcut replaces the notice so it never describes an obsolete binding.
		if (message === this.warningMessage) return;
		this.warningMessage = message;
		this.warning.clear();
		if (!message) return;
		const warning = this.notifications.notify({
			severity: Severity.Warning,
			message: message,
			actions: {
				primary: [
					{
						tooltip: '',
						enabled: true,
						id: 'screenshot.changeShortcut',
						label: localize('screenshot.shortcut.changeKeybinding', 'Change Shortcut'),
						run: () =>
							this.preferences.openGlobalKeybindingSettings(false, {
								query: `@command:${ScreenshotCommandId}`,
							}),
					},
				],
			},
		});
		this.warning.value = toDisposable(() => warning.close());
	}
}
