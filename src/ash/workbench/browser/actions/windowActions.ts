import { localize, localize2 } from '../../../nls.js';
import { getActiveWindow, getWindow } from '../../../base/browser/dom.js';
import { getWindowById, mainWindow } from '../../../base/browser/window.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { isWindowCommandContext } from '../../common/windowCommandContext.js';
import { IHostService } from '../../services/host/browser/host.js';
import { IAppServerRemoteAgentService } from '../../services/remote/common/appServerRemoteAgentService.js';

export function getWindowCommandTarget(accessor: ServicesAccessor): Window;
export function getWindowCommandTarget(accessor: ServicesAccessor, args: readonly unknown[]): Window | undefined;
export function getWindowCommandTarget(accessor: ServicesAccessor, args: readonly unknown[] = []): Window | undefined {
	const context = args.find(isWindowCommandContext);
	if (context) {
		const target = getWindowById(context.windowId)?.window;
		return target?.closed ? undefined : target;
	}
	const focused = getActiveWindow();
	// Same-renderer popups can leave both documents reporting focus. The layout owner
	// tracks input in each window and disambiguates the main-document fallback.
	return focused === mainWindow ? getWindow(accessor.get(ILayoutService).activeContainer) : focused;
}

/** Reload through the host lifecycle so resources can prepare their handoff or veto. */
export class ReloadWindowAction extends Action2 {
	static readonly ID = 'workbench.action.reloadWindow';
	constructor() { super({ id: ReloadWindowAction.ID, title: localize2('reloadWindow', 'Reload Window'), f1: true }); }
	override run(accessor: ServicesAccessor): Promise<void> { return accessor.get(IHostService).reload(); }
}

export class ShowAboutDialogAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.showAboutDialog',
			title: localize2('dialog.aboutAction', 'About Ash'),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: 'z_about', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const dialogs = accessor.get(IDialogService);
		const remote = accessor.get(IAppServerRemoteAgentService);
		const connection = remote.connection;
		if (!connection || connection.kind === 'local') {
			return dialogs.about();
		}

		const connectionType = connection.kind === 'ssh' ? 'SSH' : localize('dialog.aboutRemoteOther', 'Other');
		const details = [localize('dialog.aboutRemoteConnection', 'Remote connection: {0}', connectionType)];
		// Use the initialized host snapshot so About can open even while Remote is offline.
		if (remote.connectionState === 'connected') {
			const os = accessor.get(IAppServerApi).operatingSystem;
			if (os !== undefined) {
				details.push(localize('dialog.aboutRemoteOS', 'Remote OS: {0}', aboutOperatingSystemLabels[os]));
			}
		}
		return dialogs.about(details);
	}
}

const aboutOperatingSystemLabels: Readonly<Record<OperatingSystem, string>> = {
	[OperatingSystem.Windows]: 'Windows',
	[OperatingSystem.Macintosh]: 'macOS',
	[OperatingSystem.Linux]: 'Linux',
};
