import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_MARKETPLACE_COMMAND_ID, OPEN_PLUGINS_COMMAND_ID, type MarketplaceOpenOptions } from '../../../../platform/marketplace/common/marketplaceService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { MarketplaceViewPane } from './marketplaceViewPane.js';

registerWorkbenchContribution('workbench.contrib.marketplace', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.marketplace', title: 'Marketplace', location: ViewContainerLocation.Sidebar, icon: Lxicon.extensions, order: 8 }));
	registrations.add(ViewsRegistry.registerViews('ash.marketplace', [{ id: 'ash.marketplace.view', title: 'Marketplace', canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(MarketplaceViewPane) }]));
	registrations.add(registerAction2(class OpenMarketplace extends Action2 {
		constructor() { super({ id: OPEN_MARKETPLACE_COMMAND_ID, title: 'Open Marketplace', f1: true }); }
		public override run(accessor: ServicesAccessor, options?: MarketplaceOpenOptions | string): void {
			const view = accessor.get(IViewsService).openView('ash.marketplace.view');
			// Catalog loading and its errors belong to the view; navigation must release the Chat composer immediately.
			if (view instanceof MarketplaceViewPane) { void view.open(typeof options === 'string' ? { query: options.trim() } : options); }
		}
	}));
	registrations.add(registerAction2(class OpenPlugins extends Action2 {
		constructor() { super({ id: OPEN_PLUGINS_COMMAND_ID, title: 'Manage installed packages', f1: true }); }
		public override run(accessor: ServicesAccessor): void {
			const view = accessor.get(IViewsService).openView('ash.marketplace.view');
			if (view instanceof MarketplaceViewPane) { void view.open({ mode: 'installed' }); }
		}
	}));
	return registrations;
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OPEN_MARKETPLACE_COMMAND_ID, title: localizedString('ash', 'workbench.manageExtensions', 'Extensions') },
	group: '2_configuration',
	order: 3,
});
