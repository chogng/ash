import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import '../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationsService } from './extensionRecommendationsService.js';

import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_EXTENSIONS_COMMAND_ID, OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { registerExtensionManagementActions } from './extensionsActions.js';
import { openExtensionsView, registerExtensionsViewContainer } from './extensionsViewlet.js';

registerSingleton(IExtensionRecommendationsService, ExtensionRecommendationsService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.extensions', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(registerExtensionsViewContainer(ViewsRegistry));
	registrations.add(registerAction2(class OpenExtensions extends Action2 {
		constructor() { super({ id: OPEN_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenExtensions' }, 'Open Extensions'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: ExtensionsOpenOptions | string): Promise<void> {
			await openExtensionsView(accessor.get(IViewsService), typeof options === 'string' ? { query: options.trim() } : options);
		}
	}));
	registrations.add(registerAction2(class OpenInstalledExtensions extends Action2 {
		constructor() { super({ id: OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenPlugins' }, 'Manage Installed Extensions'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: ExtensionsOpenOptions): Promise<void> {
			await openExtensionsView(accessor.get(IViewsService), { ...options, view: 'plugins', mode: 'installed' });
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
