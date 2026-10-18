import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TerminalViewPane } from '../../../terminal/browser/terminalView.js';
import { TERMINAL_VIEW_ID } from '../../../terminal/common/terminal.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalLinkContribution } from './terminalLinkContribution.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';

registerTerminalContribution(TerminalLinkContribution.ID, TerminalLinkContribution);

registerAction2(class OpenDetectedLinkAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.terminal.openDetectedLink', title: localize2('terminal.links.open', 'Terminal: Open Detected Link…'), f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO, when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib },
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView<TerminalViewPane>(TERMINAL_VIEW_ID);
		const instance = accessor.get(ITerminalService).activeInstance;
		if (!instance) return;
		await instance.xtermReadyPromise;
		await TerminalLinkContribution.get(instance)?.showLinkQuickpick();
	}
});
