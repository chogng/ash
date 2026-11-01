import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { IQuickChatService, type IQuickChatOpenOptions } from '../chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export const ASK_QUICK_QUESTION_ACTION_ID = 'workbench.action.quickchat.toggle';

/** Register the popup's commands once with the shared Chat contribution. */
export function registerQuickChatActions(): void {
	const enabled = ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), IsSessionsWindowContext.isEqualTo(false));
	for (const id of [ASK_QUICK_QUESTION_ACTION_ID, 'workbench.action.openQuickChat']) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id, title: localize2('quickChat.open', 'Open Quick Chat'),
					precondition: enabled,
					f1: id === 'workbench.action.openQuickChat',
					keybinding: id === ASK_QUICK_QUESTION_ACTION_ID ? { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyL } : undefined,
					menu: id === ASK_QUICK_QUESTION_ACTION_ID ? { id: MenuId.ChatNewMenu, group: '1_open', order: 20, when: enabled } : undefined,
				});
			}
			run(accessor: ServicesAccessor, value?: unknown): void {
				let options: IQuickChatOpenOptions | undefined;
				if (value !== undefined) {
					if (typeof value === 'string') options = { query: value };
					else if (value && typeof value === 'object' && 'query' in value && typeof value.query === 'string'
						&& (!('isPartialQuery' in value) || typeof value.isPartialQuery === 'boolean')) {
						options = { query: value.query, isPartialQuery: 'isPartialQuery' in value ? value.isPartialQuery as boolean : undefined };
					} else throw new TypeError(localize('quickChat.invalid', 'Quick Chat expects a query string or an object with query and optional isPartialQuery.'));
					const lines = options.query.split('\n');
					const column = lines[lines.length - 1]!.length + 1;
					options = { ...options, selection: new Selection(lines.length, column, lines.length, column) };
				}
				const quickChat = accessor.get(IQuickChatService);
				if (id === ASK_QUICK_QUESTION_ACTION_ID) quickChat.toggle(options);
				else quickChat.open(options);
			}
		});
	}
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.quickchat.openInChatView',
				title: localize2('quickChat.openInView', 'Open in Chat View'),
				precondition: ChatContextKeys.inQuickChat.isEqualTo(true),
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IQuickChatService).openInChatView();
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.quickchat.close',
				title: localize2('quickChat.closeCommand', 'Close Quick Chat'),
				precondition: ChatContextKeys.inQuickChat.isEqualTo(true),
			});
		}
		run(accessor: ServicesAccessor): void {
			accessor.get(IQuickChatService).close();
		}
	});
}
