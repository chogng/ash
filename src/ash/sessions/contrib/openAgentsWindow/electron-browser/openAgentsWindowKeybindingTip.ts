import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Emitter } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, operatingSystem } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { INativeSystemWideKeybinding } from '../../../../platform/native/common/nativeHost.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { observableMemento } from '../../../../platform/observable/common/observableMemento.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatTipService, type IChatTip, type IChatTipProvider } from '../../../../workbench/contrib/chat/browser/chatTipService.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../workbench/contrib/chat/common/constants.js';
import { selectSystemWideKeybindings } from '../../../../workbench/contrib/keybindings/electron-browser/systemWideKeybindings.js';
import { IKeybindingEditingService } from '../../../../workbench/services/keybinding/common/keybindingEditing.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { OpenAgentsWindowSystemWideKeybindingContribution } from './openAgentsWindow.contribution.js';

const tipId = 'sessions.openAgentsWindowSystemWideKeybinding';
const enableCommand = 'sessions.action.enableOpenAgentsWindowSystemWideKeybinding';
const manageCommand = 'sessions.action.manageOpenAgentsWindowSystemWideKeybinding';
const recommendedMacKey = 'ctrl+cmd+a';

/** Adds onboarding to the existing desktop shortcut registration for this Sessions window. */
export class OpenAgentsWindowSystemWideKeybindingTip extends Disposable implements IChatTipProvider {
	public static readonly ID = 'workbench.contrib.openAgentsWindowSystemWideKeybindingTip';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly dismissed;
	private candidates: readonly INativeSystemWideKeybinding[];
	private awaitingRegistration = false;
	private confirmation: string | undefined;

	constructor(
		private readonly offerRecommendedKey: boolean,
		@IChatTipService tips: IChatTipService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IKeybindingEditingService private readonly editing: IKeybindingEditingService,
		@IStorageService storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
		@ILogService private readonly log: ILogService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.candidates = this.readCandidates();
		this.dismissed = this._register(observableMemento({
			key: 'sessions.openAgentsWindowSystemWideKeybindingTip.dismissed',
			defaultValue: false,
			toStorage: String,
			fromStorage: value => value === 'true',
		})(StorageScope.PROFILE, StorageTarget.USER, storage));
		this._register(this.dismissed.onDidChange(() => this.changed.fire()));
		this._register(keybindings.onDidUpdateKeybindings(() => {
			const hadRecommendedKey = this.awaitingRegistration && this.configuredShortcut(recommendedMacKey);
			this.candidates = this.readCandidates();
			if (hadRecommendedKey && !this.configuredShortcut(recommendedMacKey)) this.awaitingRegistration = false;
			if (this.confirmation && !this.configuredShortcut(this.confirmation)) this.confirmation = undefined;
			this.changed.fire();
		}));
		this._register(CommandsRegistry.register(enableCommand, () => this.enable()));
		if (!offerRecommendedKey) {
			this._register(CommandsRegistry.register(manageCommand, accessor => accessor.get(IPreferencesService).openGlobalKeybindingSettings(false, {
				query: `@command:${OPEN_AGENTS_WINDOW_COMMAND_ID}`,
			})));
		}
		this._register(tips.registerTipProvider(this));
		this._register(instantiation.createInstance(OpenAgentsWindowSystemWideKeybindingContribution, this.onRegistration.bind(this)));
	}

	public provideTip(): IChatTip | undefined {
		if (this.dismissed.get()) return undefined;
		if (this.confirmation) {
			const content = new MarkdownString();
			content.appendText(localize('openAgentsWindow.shortcutTipEnabled', 'Shortcut {0} enabled. Use it to open the Agents Window from any app while Ash is running.', this.label(this.confirmation)));
			return { id: tipId, content };
		}
		if (!this.awaitingRegistration && this.configuredShortcut()) return undefined;
		if (this.offerRecommendedKey) {
			const content = new MarkdownString('', { isTrusted: { enabledCommands: [enableCommand] } });
			content.appendLink(`command:${enableCommand}`, localize('openAgentsWindow.shortcutTipEnable', 'Enable {0}', this.label(recommendedMacKey)));
			content.appendMarkdown(' ').appendText(localize('openAgentsWindow.shortcutTipPurpose', 'to open the Agents Window from any app while Ash is running.'));
			return { id: tipId, content };
		}
		const content = new MarkdownString('', { isTrusted: { enabledCommands: [manageCommand] } });
		content.appendLink(`command:${manageCommand}`, localize('openAgentsWindow.shortcutTipConfigure', 'Set a system-wide shortcut'));
		content.appendMarkdown(' ').appendText(localize('openAgentsWindow.shortcutTipPurpose', 'to open the Agents Window from any app while Ash is running.'));
		return { id: tipId, content };
	}

	public dismissTip(id: string): void {
		if (id === tipId) this.dismissed.set(true);
	}

	private readCandidates(): readonly INativeSystemWideKeybinding[] {
		const bindings = this.keybindings.getKeybindings().flatMap(item => item.userBinding ? [item.userBinding.entry] : []);
		return selectSystemWideKeybindings(bindings, operatingSystem).candidates;
	}

	private configuredShortcut(key?: string): INativeSystemWideKeybinding | undefined {
		return this.candidates.find(candidate => candidate.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID && (!key || candidate.userSettingsLabel === key));
	}

	private label(key: string, style = KeybindingLabelStyle.UI): string {
		const binding = this.keybindings.resolveUserBinding(key);
		return binding ? getKeybindingLabel(binding, style) || key : key;
	}

	private async enable(): Promise<void> {
		if (!this.offerRecommendedKey || this.awaitingRegistration || this.configuredShortcut()) return;
		const proposed = selectSystemWideKeybindings([{ key: recommendedMacKey, command: OPEN_AGENTS_WINDOW_COMMAND_ID, systemWide: true }], operatingSystem).candidates[0];
		if (!proposed || this.candidates.some(candidate => candidate.accelerator === proposed.accelerator)) {
			this.notifications.warn(localize('openAgentsWindow.shortcutTipConflict', 'This key combination is already in use. Choose a different shortcut in Keyboard Shortcuts.'));
			return;
		}
		this.awaitingRegistration = true;
		try {
			const item = new ResolvedKeybindingItem(undefined, OPEN_AGENTS_WINDOW_COMMAND_ID, undefined, undefined, false, null, false);
			await this.editing.addKeybinding(item, recommendedMacKey, undefined, true);
		} catch (error) {
			if (this.isDisposed) return;
			this.awaitingRegistration = false;
			this.log.error('[OpenAgentsWindow] Unable to save the system-wide shortcut', error);
			this.notifications.error(localize('openAgentsWindow.shortcutTipSaveFailed', 'Unable to save the system-wide shortcut. {0}', error instanceof Error ? error.message : ''));
			this.changed.fire();
		}
	}

	private onRegistration(candidates: readonly INativeSystemWideKeybinding[], failed: readonly string[] | undefined): void {
		if (!this.awaitingRegistration || !candidates.some(candidate => candidate.userSettingsLabel === recommendedMacKey)) return;
		this.awaitingRegistration = false;
		if (failed && !failed.includes(recommendedMacKey) && this.configuredShortcut(recommendedMacKey)) {
			this.confirmation = recommendedMacKey;
			status(localize('openAgentsWindow.shortcutTipEnabled', 'Shortcut {0} enabled. Use it to open the Agents Window from any app while Ash is running.', this.label(recommendedMacKey, KeybindingLabelStyle.Aria)));
		} else if (!failed) {
			this.notifications.warn(localize('openAgentsWindow.shortcutTipRegistrationFailed', 'The system-wide shortcut was saved. Ash could not confirm registration.'));
		}
		this.changed.fire();
	}
}

registerWorkbenchContribution(
	OpenAgentsWindowSystemWideKeybindingTip.ID,
	WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(OpenAgentsWindowSystemWideKeybindingTip, isMacintosh),
);
