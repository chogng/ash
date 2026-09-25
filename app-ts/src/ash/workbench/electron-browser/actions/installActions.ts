import { isMacintosh } from '../../../base/common/platform.js';
import { localizedString } from '../../../platform/action/common/action.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { DialogSeverity, IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../nls.js';
import { INativeHostService } from '../../common/services.js';

async function changeShellCommand(accessor: ServicesAccessor, install: boolean): Promise<void> {
	const host = accessor.get(INativeHostService);
	const dialogs = accessor.get(IDialogService);
	try {
		const path = install ? await host.installShellCommand() : await host.uninstallShellCommand();
		await dialogs.showMessage({
			severity: DialogSeverity.Info,
			message: install
				? localize({ bundle: 'ash', key: 'workbench.shellCommandInstalled' }, 'The ash command is installed at {0}.', path)
				: localize({ bundle: 'ash', key: 'workbench.shellCommandUninstalled' }, 'The ash command was removed from {0}.', path),
		});
	} catch (error) {
		await dialogs.showMessage({
			severity: DialogSeverity.Error,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export class InstallShellCommandAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.installCommandLine',
			title: localizedString('ash', 'workbench.installShellCommand', 'Install ash Command in PATH'),
			f1: isMacintosh,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return changeShellCommand(accessor, true);
	}
}

export class UninstallShellCommandAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.uninstallCommandLine',
			title: localizedString('ash', 'workbench.uninstallShellCommand', 'Uninstall ash Command from PATH'),
			f1: isMacintosh,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return changeShellCommand(accessor, false);
	}
}
