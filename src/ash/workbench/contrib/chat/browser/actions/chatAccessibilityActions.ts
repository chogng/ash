import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED, IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

export const ACTION_ID_FOCUS_CHAT_CONFIRMATION = 'workbench.action.chat.focusConfirmation';

export function registerChatAccessibilityActions(): IDisposable {
	return registerAction2(class FocusChatConfirmationAction extends Action2 {
		constructor() {
			super({
				id: ACTION_ID_FOCUS_CHAT_CONFIRMATION,
				title: localize2('chat.focusConfirmation', 'Focus Chat Confirmation'),
				f1: true,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
					weight: KeybindingWeight.WorkbenchContrib,
					when: CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(true),
				},
			});
		}

		public override run(accessor: ServicesAccessor): void {
			const widgets = accessor.get(IChatWidgetService);
			const ordered = [widgets.lastFocusedWidget, ...widgets.getAllWidgets()];
			for (const widget of ordered) {
				if (!widget?.visible) { continue; }
				if (widget.input.focusConfirmation()) { return; }
			}
			accessor.get(IAccessibilityService).alert(localize('chat.noConfirmationRequired', 'No chat confirmation required.'));
		}
	});
}
