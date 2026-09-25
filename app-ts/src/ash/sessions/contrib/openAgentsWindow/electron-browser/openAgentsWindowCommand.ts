import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { ashSessionsMark } from '../browser/openAgentsWindowCommand.js';
import { createOpenDedicatedWindowApi } from '../../../../platform/windows/electron-browser/dedicatedWindowApi.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../workbench/contrib/chat/common/chat.js';

/** Registers the desktop command and its titlebar action for the current renderer. */
export function registerOpenAgentsWindowCommand(): IDisposable {
	const windowApi = createOpenDedicatedWindowApi();
	return registerAction2(class OpenAgentsWindowAction extends Action2 {
		constructor() {
			const title = localizedString('ash.actions', 'openAgentsWindow', 'Open Agents Window');
			super({
				id: OPEN_AGENTS_WINDOW_COMMAND_ID,
				title,
				tooltip: title,
				icon: ashSessionsMark,
				menu: { id: MenuId.TitleBarAdjacentCenter, group: 'navigation', order: 1 },
				f1: true,
			});
		}

		override run(): Promise<void> {
			return windowApi.openDedicatedWindow();
		}
	});
}
