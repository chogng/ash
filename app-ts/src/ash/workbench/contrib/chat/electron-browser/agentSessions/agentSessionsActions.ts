import './media/openInAgents.css';
import { localizedString } from '../../../../../platform/action/common/action.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { createOpenDedicatedWindowApi } from '../../../../../platform/windows/electron-browser/dedicatedWindowApi.js';
import { ashTitlebarMark } from '../../../../browser/parts/titlebar/titlebarMark.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../common/constants.js';

const openAgentsWindowTitle = localizedString('ash.actions', 'openAgentsWindow', 'Open Agents Window');
const openInAgentsTitle = localizedString('ash.actions', 'openInAgents', 'Open in Agents');
const openInAgentsTooltip = localizedString('ash.actions', 'openInAgentsWindow', 'Open in Agents Window');
const openAgentsWindowTitleBarCommandId = 'workbench.action.chat.openAgentsWindow.titleBar';

export class OpenAgentsWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENTS_WINDOW_COMMAND_ID,
			title: openAgentsWindowTitle,
			f1: true,
		});
	}

	override run(): Promise<void> {
		return createOpenDedicatedWindowApi().openDedicatedWindow();
	}
}

export class OpenAgentsWindowTitleBarAction extends Action2 {
	constructor() {
		super({
			id: openAgentsWindowTitleBarCommandId,
			title: openInAgentsTitle,
			tooltip: openInAgentsTooltip,
			icon: ashTitlebarMark,
			menu: { id: MenuId.TitleBarAdjacentCenter, group: 'navigation', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ICommandService).executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID);
	}
}
