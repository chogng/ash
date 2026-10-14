import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_EXTENSIONS_COMMAND_ID, OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { registerExtensionManagementActions } from './extensionsActions.js';
import { ExtensionsViewPane, registerExtensionsViewContainer } from './extensionsViewlet.js';
import { SkillsViewPane, McpServersViewPane } from './extensionsViews.js';

registerWorkbenchContribution('workbench.contrib.extensions', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(registerExtensionsViewContainer(ViewsRegistry));
	registrations.add(registerAction2(class OpenExtensions extends Action2 {
		constructor() { super({ id: OPEN_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenExtensions' }, 'Open Extensions'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: ExtensionsOpenOptions | string): Promise<void> {
			const view = await accessor.get(IViewsService).openView(options && typeof options !== 'string' && options.view && options.view !== 'extensions' ? `ash.extensions.${options.view}` : 'ash.extensions.view', true);
			// Catalog loading and its errors belong to the view; navigation must release the Chat composer immediately.
			if (view instanceof ExtensionsViewPane || view instanceof SkillsViewPane || view instanceof McpServersViewPane) {
				void view.open(typeof options === 'string' ? { query: options.trim() } : options);
			}
		}
	}));
	registrations.add(registerAction2(class OpenInstalledExtensions extends Action2 {
		constructor() { super({ id: OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenPlugins' }, 'Manage installed packages'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: ExtensionsOpenOptions): Promise<void> {
			const view = await accessor.get(IViewsService).openView('ash.extensions.plugins', true);
			if (view instanceof ExtensionsViewPane) { void view.open({ ...options, mode: 'installed' }); }
		}
	}));
	registrations.add(registerExtensionManagementActions());
	return registrations;
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OPEN_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash', key: 'workbench.manageExtensions' }, 'Extensions') },
	group: '2_configuration',
	order: 3,
});
