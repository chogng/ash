import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICallService } from '../../../../platform/call/common/callService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { CallViewPane } from './callViewPane.js';
import './media/call.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.calls', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Calls accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Calls accessibility help', description: 'Announce keyboard help when the Calls view receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.call', WorkbenchPhase.BlockStartup, accessor => {
	const registrations = new DisposableStore();
	if (!accessor.getOptional(ICallService)) { return registrations; }
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.call', title: 'Calls', location: ViewContainerLocation.Panel, order: 4 }));
	registrations.add(ViewsRegistry.registerViews('ash.call', [{
		id: 'ash.call.view', title: 'Calls', canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(CallViewPane),
	}]));
	registrations.add(registerAction2(class OpenCalls extends Action2 {
		constructor() { super({ id: 'ash.call.open', title: 'Open Calls', f1: true }); }
		public override run(accessor: ServicesAccessor): void { accessor.get(IViewsService).focusView('ash.call.view'); }
	}));
	return registrations;
});
