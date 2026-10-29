import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';
import { ChangesViewMode } from '../common/changes.js';
import { IChangesViewService } from '../common/changesViewService.js';

class SetChangesListViewModeAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.agentSessions.setChangesListViewMode', title: localize2({ bundle: 'ash', key: 'sessions.changes.viewAsList' }, 'Changes: View as List'), f1: true });
	}

	public run(accessor: ServicesAccessor): void {
		accessor.get(IChangesViewService).setViewMode(ChangesViewMode.List);
	}
}

class SetChangesTreeViewModeAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.agentSessions.setChangesTreeViewMode', title: localize2({ bundle: 'ash', key: 'sessions.changes.viewAsTree' }, 'Changes: View as Tree'), f1: true });
	}

	public run(accessor: ServicesAccessor): void {
		accessor.get(IChangesViewService).setViewMode(ChangesViewMode.Tree);
	}
}

registerAction2(SetChangesListViewModeAction);
registerAction2(SetChangesTreeViewModeAction);
