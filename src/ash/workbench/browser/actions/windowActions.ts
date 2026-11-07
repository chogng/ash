import { localize2 } from '../../../nls.js';
import { getActiveWindow, getWindow } from '../../../base/browser/dom.js';
import { getWindowById, mainWindow } from '../../../base/browser/window.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { isWindowCommandContext } from '../../common/windowCommandContext.js';
import { IHostService } from '../../services/host/browser/host.js';

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
		return accessor.get(IDialogService).about();
	}
}
