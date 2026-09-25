import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServiceConstructionDescriptor } from '../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkspaceFolderCountContext } from '../../../common/contextkeys.js';
import { type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import { IWorkspaceOpenService } from '../../../services/workspaces/browser/workspaceOpenService.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { VIEW_ID } from '../common/files.js';
import { EmptyView } from './views/emptyView.js';
import { ExplorerView } from './views/explorerView.js';
import { OpenEditorsView } from './views/openEditorsView.js';
import './media/explorerviewlet.css';

/** Registers the Explorer views after the sidebar container exists. */
export function registerFilesViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViews(WorkbenchViewContainerId.Sidebar, [
		{
			id: OpenEditorsView.ID,
			title: 'Open Editors',
			localizationKey: { bundle: 'ash.views', key: 'openEditors' },
			order: 0,
			hideByDefault: true,
			canToggleVisibility: true,
			ctorDescriptor: new ServiceConstructionDescriptor(OpenEditorsView),
		},
		{
			id: VIEW_ID,
			title: 'Explorer',
			localizationKey: { bundle: 'ash.views', key: 'explorer' },
			order: 1,
			when: ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0),
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(ExplorerView),
		},
		{
			id: EmptyView.ID,
			title: EmptyView.TITLE,
			order: 2,
			when: WorkspaceFolderCountContext.isEqualTo(0),
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(EmptyView, {
				serviceDependencies: [IWorkspaceOpenService],
			}),
		},
	]);
}

registerAction2(class FocusOpenEditorsViewAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.files.action.focusOpenEditorsView',
			title: localizedString('ash', 'files.openEditors.focus', 'Focus Open Editors'),
			f1: true,
			keybinding: { primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('e')) },
		});
	}

	public override run(accessor: ServicesAccessor): void {
		accessor.get(IViewsService).focusView(OpenEditorsView.ID);
	}
});
