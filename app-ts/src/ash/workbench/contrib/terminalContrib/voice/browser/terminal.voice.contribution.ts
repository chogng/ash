import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/browser/viewsService.js';
import { TerminalViewPane } from '../../../terminal/browser/terminalView.js';
import { TERMINAL_VIEW_ID } from '../../../terminal/common/terminal.js';

registerAction2(class TerminalStartVoiceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.terminal.startVoice',
			title: localize2({ bundle: 'ash', key: 'dictation.terminalStart' }, 'Terminal: Start dictation'),
			f1: true,
			icon: Lxicon.mic,
			menu: { id: MenuId.TerminalTitle, group: 'navigation', order: 15, when: ContextKeyExpr.equals('terminalActiveInstanceState', 'running') },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView(TERMINAL_VIEW_ID);
		return view instanceof TerminalViewPane ? view.startVoice() : undefined;
	}
});
registerAction2(class TerminalStopVoiceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.terminal.stopVoice',
			title: localize2({ bundle: 'ash', key: 'dictation.terminalStop' }, 'Terminal: Stop dictation'),
			f1: true,
		});
	}
	public override run(accessor: ServicesAccessor): Promise<void> | undefined {
		const view = accessor.get(IViewsService).getViewWithId(TERMINAL_VIEW_ID);
		return view instanceof TerminalViewPane ? view.stopVoice() : undefined;
	}
});
