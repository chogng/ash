import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

export const AcceptElicitationRequestActionId = 'workbench.action.chat.acceptElicitation';

export function registerChatElicitationActions(): IDisposable {
	return registerAction2(class AcceptElicitationRequestAction extends Action2 {
		constructor() {
			super({
				id: AcceptElicitationRequestActionId, title: localize2('chat.acceptElicitation', 'Chat: Submit Requested Answers'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.Enter, weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ContextKeyExpr.has('chatElicitationFocused'))
				}
			});
		}
		public override run(accessor: ServicesAccessor): void {
			const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
			if (!widget?.visible) { return; }
			widget.input.acceptElicitation();
		}
	});
}
