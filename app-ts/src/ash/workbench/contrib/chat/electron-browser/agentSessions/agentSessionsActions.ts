import './media/openInAgents.css';
import { localizedString } from '../../../../../platform/action/common/action.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ashTitlebarMark } from '../../../../browser/parts/titlebar/titlebarMark.js';
import { INativeHostService } from '../../../../common/services.js';
import { validateOpenAgentsWindow } from '../../../../../platform/native/common/nativeHost.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../common/constants.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

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

	override run(accessor: ServicesAccessor, options?: unknown): Promise<void> {
		return accessor.get(INativeHostService).openAgentsWindow(validateOpenAgentsWindow(options));
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

	override async run(accessor: ServicesAccessor): Promise<void> {
		const navigation = accessor.get(IChatSessionNavigationService);
		const conversation = navigation.getActiveConversation();
		const captured = await navigation.captureActiveDraft();
		await accessor.get(INativeHostService).openAgentsWindow(conversation || captured ? { conversation, draft: captured?.draft } : undefined);
		// Only the target window's acknowledgement transfers ownership of an unsent draft.
		captured?.clear();
	}
}
