import { Disposable } from '../../../../base/common/lifecycle.js';
import { operatingSystem } from '../../../../base/common/platform.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService, type ILogService as LogService } from '../../../../platform/log/common/log.js';
import type { INativeSystemWideKeybinding } from '../../../../platform/native/common/nativeHost.js';
import { INotificationService, type INotificationService as NotificationService } from '../../../../platform/notification/common/notification.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../workbench/contrib/chat/common/constants.js';
import { selectSystemWideKeybindings } from '../../../../workbench/contrib/keybindings/electron-browser/systemWideKeybindings.js';
import {
	type ISystemWideKeybindingsSynchronizerOptions,
	SystemWideKeybindingsSynchronizer,
} from '../../../../workbench/contrib/keybindings/electron-browser/systemWideKeybindingsSynchronizer.js';

/** Keeps the desktop's global Open Agents Window shortcut in step with user keybindings. */
export class OpenAgentsWindowSystemWideKeybindingContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.openAgentsWindowSystemWideKeybinding';
	private lastFailed = '';
	private lastIgnoredWhen = '';

	constructor(
		onRegistration: ((candidates: readonly INativeSystemWideKeybinding[], failed: readonly string[] | undefined) => void) | undefined,
		@IKeybindingService resource: IKeybindingService,
		@INotificationService private readonly notifications: NotificationService,
		@ILogService private readonly log: LogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const options: ISystemWideKeybindingsSynchronizerOptions = {
			getCandidates: () => {
				const selection = selectSystemWideKeybindings(
					resource.getKeybindings().flatMap(item => item.userBinding ? [item.userBinding.entry] : []),
					operatingSystem,
				);
				for (const rejection of selection.unsupported) {
					if (rejection.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID) {
						this.log.warn(`[OpenAgentsWindow] ${rejection.userSettingsLabel} cannot be registered as a system-wide shortcut`);
					}
				}
				for (const rejection of selection.duplicates) {
					if (rejection.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID) {
						this.log.warn(`[OpenAgentsWindow] duplicate system-wide shortcut ${rejection.userSettingsLabel}`);
					}
				}
				const ignoredWhen = selection.ignoredWhen.filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID).map(binding => binding.userSettingsLabel).join(', ');
				if (ignoredWhen && ignoredWhen !== this.lastIgnoredWhen) {
					this.notifications.warn(localize('openAgentsWindow.systemWideWhenIgnored', 'The when condition is ignored for system-wide Open Agents Window shortcuts ({0}).', ignoredWhen));
				}
				this.lastIgnoredWhen = ignoredWhen;
				return selection.candidates.filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID);
			},
			onRegistrationResult: (candidates, failed) => {
				this.reportFailures(failed);
				onRegistration?.(candidates, failed);
			},
			onError: (error, candidates) => {
				this.log.error('[OpenAgentsWindow] Unable to sync system-wide shortcuts', error);
				onRegistration?.(candidates, undefined);
			},
		};
		this._register(instantiationService.createInstance(SystemWideKeybindingsSynchronizer, options));
	}

	private reportFailures(failedLabels: readonly string[]): void {
		const failed = failedLabels.join(', ');
		if (failed && failed !== this.lastFailed) {
			this.notifications.warn(localize('openAgentsWindow.systemWideFailed', 'Some system-wide shortcuts could not be registered ({0}); they may be used by another application.', failed));
		}
		this.lastFailed = failed;
	}
}

registerWorkbenchContribution(
	OpenAgentsWindowSystemWideKeybindingContribution.ID,
	WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(OpenAgentsWindowSystemWideKeybindingContribution, undefined),
);
