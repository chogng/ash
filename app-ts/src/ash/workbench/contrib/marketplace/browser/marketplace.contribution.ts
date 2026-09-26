import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_MARKETPLACE_COMMAND_ID, OPEN_PLUGINS_COMMAND_ID, type MarketplaceOpenOptions } from '../../../../platform/marketplace/common/marketplaceService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { MarketplaceViewPane } from './marketplaceViewPane.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.marketplace', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Marketplace accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Marketplace accessibility help', description: 'Announce keyboard help when Marketplace receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.marketplace', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.marketplace', title: 'Marketplace', location: ViewContainerLocation.Sidebar, icon: Lxicon.extensions, order: 8 }));
	registrations.add(ViewsRegistry.registerViews('ash.marketplace', [{ id: 'ash.marketplace.view', title: 'Marketplace', canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(MarketplaceViewPane) }]));
	registrations.add(registerAction2(class OpenMarketplace extends Action2 {
		constructor() { super({ id: OPEN_MARKETPLACE_COMMAND_ID, title: 'Open Marketplace', f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: MarketplaceOpenOptions | string): Promise<void> {
			const view = accessor.get(IViewsService).openView('ash.marketplace.view');
			if (view instanceof MarketplaceViewPane) { await view.open(typeof options === 'string' ? { query: options.trim() } : options); }
		}
	}));
	registrations.add(registerAction2(class OpenPlugins extends Action2 {
		constructor() { super({ id: OPEN_PLUGINS_COMMAND_ID, title: 'Manage installed packages', f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const view = accessor.get(IViewsService).openView('ash.marketplace.view');
			if (view instanceof MarketplaceViewPane) { await view.open({ mode: 'installed' }); }
		}
	}));
	return registrations;
});
