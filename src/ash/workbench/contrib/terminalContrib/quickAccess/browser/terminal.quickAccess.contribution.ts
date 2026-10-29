import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { QuickAccessRegistry } from '../../../../../platform/quickinput/common/quickAccess.js';
import {
	IQuickInputService,
	QuickInputType,
	type IQuickPick,
	type IQuickPickItem,
} from '../../../../../platform/quickinput/common/quickInput.js';
import { TerminalQuickAccessProvider } from './terminalQuickAccess.js';

QuickAccessRegistry.register({
	prefix: TerminalQuickAccessProvider.PREFIX,
	ctor: TerminalQuickAccessProvider,
	get placeholder() {
		return localize('terminal.quickAccess.placeholder', 'Type the name of a terminal to open');
	},
	get helpLabel() {
		return localize('terminal.quickAccess.help', 'Show All Opened Terminals');
	},
});

registerAction2(
	class SwitchActiveTerminalAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.quickOpenTerm',
				title: localize2('terminal.quickAccess.switch', 'Terminal: Switch Active Terminal'),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			accessor.get(IQuickInputService).quickAccess.show(TerminalQuickAccessProvider.PREFIX);
		}
	},
);

for (const [id, next] of [
	['workbench.action.quickOpenNavigateNextInTerminalPicker', true],
	['workbench.action.quickOpenNavigatePreviousInTerminalPicker', false],
] as const) {
	CommandsRegistry.register(id, accessor => {
		const quickInput = accessor.get(IQuickInputService);
		const picker = quickInput.currentQuickInput;
		if (
			picker?.type === QuickInputType.QuickPick &&
			(picker as IQuickPick<IQuickPickItem>).value.startsWith(TerminalQuickAccessProvider.PREFIX)
		)
			quickInput.navigate(next);
	});
}
