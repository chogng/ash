import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../../../nls.js';
import { ChatConfiguration } from '../../../common/constants.js';

export const multipleChatTips = new RawContextKey<boolean>('multipleChatTips', false);

/** Menu commands stay registered when the tip widget is replaced during development. */
export class ChatTipActionContext {
	constructor(
		readonly dismiss: () => void,
		readonly navigate: ((direction: -1 | 1) => void) | undefined,
		readonly isDisposed: () => boolean,
	) { }
}

for (const [order, direction, id, title, icon] of [
	[1, -1, 'workbench.action.chat.previousTip', () => localize2('chat.tip.previous', 'Previous tip'), Lxicon.chevronLeft],
	[2, 1, 'workbench.action.chat.nextTip', () => localize2('chat.tip.next', 'Next tip'), Lxicon.chevronRight],
	[3, undefined, 'workbench.action.chat.dismissTipToolbar', () => localize2('chat.tip.dismiss', 'Dismiss tip'), Lxicon.close],
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id, get title() { return title(); }, icon,
				menu: { id: MenuId.ChatTipToolbar, group: 'navigation', order, when: direction === undefined ? undefined : multipleChatTips.isEqualTo(true) },
			});
		}

		override run(_accessor: ServicesAccessor, target: unknown): void {
			if (!(target instanceof ChatTipActionContext) || target.isDisposed()) return;
			if (direction === undefined) target.dismiss();
			else target.navigate?.(direction);
		}
	});
}
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.dismissTip',
			get title() { return localize2('chat.tip.dismissCurrent', 'Dismiss This Tip'); },
			menu: { id: MenuId.ChatTipContext, group: 'navigation', order: 1 },
		});
	}

	override run(_accessor: ServicesAccessor, target: unknown): void {
		if (target instanceof ChatTipActionContext && !target.isDisposed()) target.dismiss();
	}
});
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.disableTips',
			get title() { return localize2('chat.tip.disableAll', 'Disable All Tips'); },
			menu: { id: MenuId.ChatTipContext, group: 'navigation', order: 2 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IConfigurationService).updateValue(ChatConfiguration.TipsEnabled, false);
	}
});
