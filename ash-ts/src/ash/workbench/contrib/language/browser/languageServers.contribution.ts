import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_LANGUAGE_SERVERS_COMMAND_ID } from '../../../../platform/language/common/languageServerService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { LanguageServersViewPane } from './languageServersViewPane.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.languageServers', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Language servers accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Language servers accessibility help', description: 'Announce keyboard help when the language servers view receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.languageServers', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.languageServers', title: 'Language servers', location: ViewContainerLocation.Sidebar, order: 9 }));
	registrations.add(ViewsRegistry.registerViews('ash.languageServers', [{ id: 'ash.languageServers.view', title: 'Language servers', canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(LanguageServersViewPane) }]));
	registrations.add(registerAction2(class OpenView extends Action2 {
		constructor() { super({ id: OPEN_LANGUAGE_SERVERS_COMMAND_ID, title: 'Open language servers', f1: true }); }
		public override run(accessor: ServicesAccessor): void { accessor.get(IViewsService).focusView('ash.languageServers.view'); }
	}));
	return registrations;
});
