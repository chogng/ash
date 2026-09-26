import { Disposable } from '../../../../base/common/lifecycle.js';
import { operatingSystem } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IKeybindingsResourceService, type IKeybindingsResourceService as KeybindingsResourceService } from '../../../../platform/keybinding/common/keybindingsResource.js';
import { ILogService, type ILogService as LogService } from '../../../../platform/log/common/log.js';
import { INotificationService, type INotificationService as NotificationService } from '../../../../platform/notification/common/notification.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../workbench/contrib/chat/common/constants.js';
import { selectSystemWideKeybindings } from '../../../../workbench/contrib/keybindings/electron-browser/systemWideKeybindings.js';
import { SystemWideKeybindingsSynchronizer } from '../../../../workbench/contrib/keybindings/electron-browser/systemWideKeybindingsSynchronizer.js';

/** Keeps the desktop's global Open Agents Window shortcut in step with user keybindings. */
export class OpenAgentsWindowSystemWideKeybindingContribution extends Disposable {
	private lastFailed = '';
	private lastIgnoredWhen = '';

	constructor(
		resource: KeybindingsResourceService,
		private readonly notifications: NotificationService,
		private readonly log: LogService,
	) {
		super();
		this._register(new SystemWideKeybindingsSynchronizer({
			getCandidates: () => {
				const selection = selectSystemWideKeybindings(
					resource.getKeybindings().filter(binding => binding.command === OPEN_AGENTS_WINDOW_COMMAND_ID),
					operatingSystem,
				);
				for (const key of selection.unsupported) this.log.warn(`[OpenAgentsWindow] ${key} cannot be registered as a system-wide shortcut`);
				for (const key of selection.duplicates) this.log.warn(`[OpenAgentsWindow] duplicate system-wide shortcut ${key}`);
				const ignoredWhen = selection.ignoredWhen.join(', ');
				if (ignoredWhen && ignoredWhen !== this.lastIgnoredWhen) {
					this.notifications.warning(localize('openAgentsWindow.systemWideWhenIgnored', 'The when condition is ignored for system-wide Open Agents Window shortcuts ({0}).', ignoredWhen));
				}
				this.lastIgnoredWhen = ignoredWhen;
				return selection.candidates;
			},
			onRegistrationFailuresChanged: failed => this.reportFailures(failed),
			onError: error => this.log.error('[OpenAgentsWindow] Unable to sync system-wide shortcuts', error),
		}, resource));
	}

	private reportFailures(failedLabels: readonly string[]): void {
		const failed = failedLabels.join(', ');
		if (failed && failed !== this.lastFailed) {
			this.notifications.warning(localize('openAgentsWindow.systemWideFailed', 'Some system-wide shortcuts could not be registered ({0}); they may be used by another application.', failed));
		}
		this.lastFailed = failed;
	}
}

registerWorkbenchContribution(
	'workbench.contrib.openAgentsWindowSystemWideKeybinding',
	WorkbenchPhase.AfterRestored,
	accessor => new OpenAgentsWindowSystemWideKeybindingContribution(
		accessor.get(IKeybindingsResourceService),
		accessor.get(INotificationService),
		accessor.get(ILogService),
	),
);
