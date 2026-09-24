import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IAutomationService } from '../../../../platform/automation/common/automationService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { AutomationViewPane } from './automationViewPane.js';
import './media/automation.css';

function registerAutomationView(): IDisposable {
	const registrations = new DisposableStore();
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.automation', title: 'Automations', location: ViewContainerLocation.Panel, order: 3 }));
	registrations.add(ViewsRegistry.registerViews('ash.automation', [{ id: 'ash.automation.view', title: 'Automations', canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(AutomationViewPane, { serviceDependencies: [IAutomationService, IWorkspaceContextService, IChatSessionNavigationService, ICommandService] }) }]));
	registrations.add(registerAction2(class OpenAutomations extends Action2 {
		constructor() { super({ id: 'ash.automation.open', title: 'Open Automations', f1: true }); }
		public override run(accessor: ServicesAccessor): void { accessor.get(IViewsService).focusView('ash.automation.view'); }
	}));
	return registrations;
}

registerWorkbenchContribution('workbench.contrib.automation', WorkbenchPhase.BlockStartup, accessor => accessor.getOptional(IAutomationService) ? registerAutomationView() : new DisposableStore());
