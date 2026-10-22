import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { matchesSubString } from '../../../../base/common/filters.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { PickerQuickAccessProvider, type IPickerQuickAccessItem, type Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDebugService, SELECT_AND_START_ID } from '../common/debug.js';
import { DEBUG_QUICK_ACCESS_PREFIX } from './debugCommands.js';

/** Borrows the launch catalog; configuration selection and execution stay in DebugService. */
export class StartDebugQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	constructor(
		@IDebugService private readonly debug: IDebugService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(DEBUG_QUICK_ACCESS_PREFIX); }

	protected override async _getPicks(filter: string, resources: DisposableStore, token: CancellationToken): Promise<Picks<IPickerQuickAccessItem>> {
		const workspace = this.workspace.getWorkspace();
		resources.add(this.workspace.onDidChangeWorkspace(() => this.refresh()));
		await this.debug.refresh();
		if (token.isCancellationRequested || this.workspace.getWorkspace() !== workspace) return [];
		const manager = this.debug.getConfigurationManager();
		const picks: IPickerQuickAccessItem[] = manager.getAllConfigurations().flatMap(configuration => {
			const highlights = matchesSubString(filter, configuration.name);
			if (!highlights) return [];
			return [{
				label: configuration.name, description: configuration.workspaceFolderName,
				accept: () => {
					// Closing the picker retires its query, but the accepted launch owns its operation.
					if (this.workspace.getWorkspace() !== workspace || !manager.getAllConfigurations().includes(configuration)) return;
					void (async () => {
						await manager.selectConfiguration(configuration);
						if (this.workspace.getWorkspace() !== workspace) return;
						if ('configurations' in configuration) await this.debug.startCompound(configuration);
						else await this.debug.start(configuration);
					})().catch(error => this.notifications.error(error));
				},
			}];
		});
		const dynamicLabel = localize('debug.moreConfigurations', 'Select and Start Debugging…');
		if (!filter || matchesSubString(filter, dynamicLabel)) picks.push({
			label: dynamicLabel,
			accept: () => { void this.commands.executeCommand(SELECT_AND_START_ID).catch(error => this.notifications.error(error)); },
		});
		return picks;
	}
}
