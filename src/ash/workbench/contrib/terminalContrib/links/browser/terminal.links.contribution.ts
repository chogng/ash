import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TerminalViewPane } from '../../../terminal/browser/terminalView.js';
import { TERMINAL_VIEW_ID } from '../../../terminal/common/terminal.js';

registerAction2(class OpenDetectedLinkAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.terminal.openDetectedLink', title: localize2('terminal.links.open', 'Terminal: Open Detected Link…'), f1: true });
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView<TerminalViewPane>(TERMINAL_VIEW_ID);
		await view?.openDetectedLink();
	}
});
