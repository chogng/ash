import { localize2 } from '../../../nls.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IHostService } from '../../services/host/browser/host.js';

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
