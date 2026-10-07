import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickAccessController } from '../../../../platform/quickinput/common/quickAccess.js';
import { localize2 } from '../../../../nls.js';
import { SymbolsQuickAccessProvider } from './symbolsQuickAccess.js';

registerAction2(class ShowAllSymbolsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.showAllSymbols',
			get title() { return localize2('quickAccess.goToWorkspaceSymbol', 'Go to Symbol in Workspace'); },
			f1: true,
			menu: { id: MenuId.MenubarGoMenu, group: '2_navigation', order: 2 },
			keybinding: { primary: Keybinding.single(logicalKey('t', { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickAccessController).show(SymbolsQuickAccessProvider.PREFIX);
	}
});
