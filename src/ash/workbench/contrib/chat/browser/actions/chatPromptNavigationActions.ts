import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

export function registerChatPromptNavigationActions(): DisposableStore {
	const registrations = new DisposableStore();
	for (const direction of ['next', 'previous'] as const) {
		registrations.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: direction === 'next' ? 'workbench.action.chat.nextUserPrompt' : 'workbench.action.chat.previousUserPrompt',
					title: direction === 'next'
						? localize2('interactive.nextUserPrompt.label', 'Next User Prompt')
						: localize2('interactive.previousUserPrompt.label', 'Previous User Prompt'),
					f1: true,
					precondition: ChatContextKeys.enabled.isEqualTo(true),
					keybinding: {
						primary: KeyMod.CtrlCmd | KeyMod.Alt | (direction === 'next' ? KeyCode.DownArrow : KeyCode.UpArrow),
						weight: KeybindingWeight.WorkbenchContrib,
						when: ChatContextKeys.inChatSession.isEqualTo(true),
					},
				});
			}

			public override run(accessor: ServicesAccessor): void {
				const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
				if (!widget?.visible) { return; }
				let anchor = widget.getFocus();
				// Ash renders tool/reasoning rows separately; they belong to the preceding request.
				while (anchor && anchor.type !== 'userMessage') { anchor = widget.getSibling(anchor, 'previous'); }
				let candidate = widget.getSibling(anchor, direction);
				while (candidate) {
					if (candidate.type === 'userMessage') {
						widget.focus(candidate);
						widget.reveal(candidate);
						return;
					}
					candidate = widget.getSibling(candidate, direction);
				}
			}
		}));
	}
	return registrations;
}
