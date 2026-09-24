import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_SKILLS_COMMAND_ID } from '../../../../platform/skills/common/skillService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { SkillsViewPane } from './skillsViewPane.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.skills', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Skills accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Skills accessibility help', description: 'Announce keyboard help when the skills view receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.skills', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.skills', title: 'Skills', location: ViewContainerLocation.Sidebar, order: 9 }));
	registrations.add(ViewsRegistry.registerViews('ash.skills', [{ id: 'ash.skills.view', title: 'Skills', canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(SkillsViewPane) }]));
	registrations.add(registerAction2(class OpenView extends Action2 {
		constructor() { super({ id: OPEN_SKILLS_COMMAND_ID, title: 'Open skills', f1: true }); }
		public override run(accessor: ServicesAccessor): void { accessor.get(IViewsService).focusView('ash.skills.view'); }
	}));
	return registrations;
});
