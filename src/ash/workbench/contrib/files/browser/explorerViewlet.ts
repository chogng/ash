import { localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkspaceFolderCountContext } from '../../../common/contextkeys.js';
import { type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
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
			ctorDescriptor: new SyncDescriptor(OpenEditorsView),
		},
		{
			id: VIEW_ID,
			title: 'Explorer',
			localizationKey: { bundle: 'ash.views', key: 'explorer' },
			order: 1,
			when: ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0),
			canToggleVisibility: false,
			ctorDescriptor: new SyncDescriptor(ExplorerView),
		},
		{
			id: EmptyView.ID,
			title: EmptyView.TITLE,
			order: 2,
			when: WorkspaceFolderCountContext.isEqualTo(0),
			canToggleVisibility: false,
			ctorDescriptor: new SyncDescriptor(EmptyView),
		},
	]);
}

registerAction2(class FocusOpenEditorsViewAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.files.action.focusOpenEditorsView',
			title: localize2({ bundle: 'ash', key: 'files.openEditors.focus' }, 'Focus Open Editors'),
			f1: true,
			keybinding: { primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('e')) },
		});
	}

	public override run(accessor: ServicesAccessor): Promise<boolean> {
		return accessor.get(IViewsService).focusView(OpenEditorsView.ID);
	}
});
