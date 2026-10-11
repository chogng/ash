import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';

export const CONFIGURE_SKILLS_ACTION_ID = 'workbench.action.chat.configure.skills';

export function registerSkillActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CONFIGURE_SKILLS_ACTION_ID, title: localize2({ bundle: 'ash', key: 'skills.open' }, 'Open skills'), f1: true });
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { view: 'skills' });
		}
	});
}
