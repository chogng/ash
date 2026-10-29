import { localize2 } from '../../../nls.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../workbench/common/services.js';
import { OPEN_ASH_WINDOW_COMMAND_ID } from '../../common/sessionCommands.js';

export class OpenAshWindowAction extends Action2 {
	public static readonly ID = OPEN_ASH_WINDOW_COMMAND_ID;

	constructor() {
		super({ id: OpenAshWindowAction.ID, title: localize2({ bundle: 'ash', key: 'sessions.menu.openIde' }, 'Open IDE'), f1: true });
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		// Main selects an IDE window without mistaking an auxiliary chat for one.
		await accessor.get(INativeHostService).openWindow({ forceReuseWindow: true });
	}
}
