import { localize2, localize } from '../../../../nls.js';

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Severity, INotificationService, type INotificationHandle } from '../../../../platform/notification/common/notification.js';
import { IUpdateService, type UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import { IMeteredConnectionService } from '../../../../platform/meteredConnection/common/meteredConnection.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';

const CHECK_FOR_UPDATES_COMMAND_ID = 'update.checkForUpdate';

class CheckForUpdatesAction extends Action2 {
	constructor() {
		super({
			id: CHECK_FOR_UPDATES_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'update.checkForUpdates' }, 'Check for Updates...'),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: '1_update', order: 1 },
		});
	}

	override async run(services: ServicesAccessor): Promise<void> {
		const notifications = services.get(INotificationService);
		const update = services.get(IUpdateService);
		const checking = notifications.notify({ severity: Severity.Info, message: localize('update.checking', 'Checking for updates...') });
		try {
			const result = await update.checkForUpdates();
			if (result.status === 'available') {
				showAvailableUpdate(notifications, update, result, !services.get(IContextKeyService).getValue(IsSessionsWindowContext.key));
			} else {
				notifications.info(localize('update.current', 'Ash {0} is up to date.', result.version));
			}
		} catch (error) {
			console.error('Desktop update check failed', error);
			notifications.error(localize('update.checkFailed', 'Could not check for updates.'));
		} finally {
			checking.close();
		}
	}
}

function showAvailableUpdate(notifications: INotificationService, update: IUpdateService, result: Extract<UpdateCheckResult, { status: 'available'; }>, showUpdateNotifications: boolean): void {
	let prompt: INotificationHandle;
	prompt = notifications.notify({
		severity: Severity.Info, message: localize('update.available', 'Ash {0} is available. You are using {1}.', result.version, result.currentVersion), actions: {
			primary: [{
				tooltip: '',
				enabled: true,
				id: 'update.download',
				label: localize('update.download', 'Download Update'),
				run: async () => {
					prompt.close();
					const downloading = showUpdateNotifications ? notifications.notify({ severity: Severity.Info, message: localize('update.downloading', 'Downloading and verifying Ash update...') }) : undefined;
					try {
						const ready = await update.downloadUpdate();
						if (showUpdateNotifications) showReadyUpdate(notifications, update, ready.version);
					} catch (error) {
						console.error('Desktop update download failed', error);
						notifications.error(localize('update.downloadFailed', 'Could not download the update.'));
					} finally {
						downloading?.close();
					}
				},
			}]
		}
	});
}

function showReadyUpdate(notifications: INotificationService, update: IUpdateService, version: string): void {
	let prompt: INotificationHandle;
	prompt = notifications.notify({
		severity: Severity.Info, message: localize('update.ready', 'Ash {0} is ready to install.', version), actions: {
			primary: [{
				tooltip: '',
				enabled: true,
				id: 'update.install',
				label: localize('update.install', 'Install and Restart'),
				run: async () => {
					try {
						await update.installUpdate();
						prompt.close();
					} catch (error) {
						console.error('Desktop update installation failed', error);
						notifications.error(localize('update.installFailed', 'Could not install the update.'));
					}
				},
			}]
		}
	});
}

if (isWindows || isMacintosh) {
	registerAction2(CheckForUpdatesAction);
	registerWorkbenchContribution('workbench.contrib.desktopAutomaticUpdate', WorkbenchPhase.AfterRestored, accessor => {
		const update = accessor.get(IUpdateService);
		const notifications = accessor.get(INotificationService);
		const meteredConnection = accessor.get(IMeteredConnectionService);
		const showUpdateNotifications = !accessor.get(IContextKeyService).getValue(IsSessionsWindowContext.key);
		let disposed = false;
		let started = false;
		const check = async (): Promise<void> => {
			try {
				const result = await update.checkAutomatically();
				if (!disposed && result?.status === 'available') showAvailableUpdate(notifications, update, result, showUpdateNotifications);
			} catch (error) {
				console.error('Automatic Desktop update check failed', error);
			}
		};
		let interval: ReturnType<typeof setInterval> | undefined;
		const networkChange = meteredConnection.onDidChangeIsConnectionMetered(isMetered => {
			if (started && !isMetered) void check();
		});
		const initial = setTimeout(() => {
			started = true;
			void check();
			interval = setInterval(() => { void check(); }, 24 * 60 * 60 * 1000);
		}, 60_000);
		return toDisposable(() => { disposed = true; networkChange.dispose(); clearTimeout(initial); if (interval) clearInterval(interval); });
	});
	MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
		command: { id: CHECK_FOR_UPDATES_COMMAND_ID, title: localize2({ bundle: 'ash', key: 'update.checkForUpdates' }, 'Check for Updates...') },
		group: '7_update',
		order: 1,
	});
}
