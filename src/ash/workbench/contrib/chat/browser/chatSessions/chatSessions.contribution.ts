import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_VIEW_ID, OPEN_CHAT_COMMAND_ID } from '../../common/chat.js';

/** The Code host registers its Chat view command; Sessions retains its own navigation. */
export function registerChatSessionsActions(): void {
	registerAction2(
		class OpenChatAction extends Action2 {
			constructor() {
				super({
					id: OPEN_CHAT_COMMAND_ID,
					precondition: ChatContextKeys.enabled.isEqualTo(true),
					title: localize2({ bundle: 'ash.sessions', key: 'command.OpenChatAction' }, 'Open Chat'),
					icon: Lxicon.chat4,
					f1: true,
				});
			}

			override run(accessor: ServicesAccessor): Promise<boolean> {
				if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId))
					return Promise.resolve(false);
				return accessor.get(IViewsService).focusView(CHAT_VIEW_ID);
			}
		},
	);
}
