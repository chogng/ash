import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { ContextKeyExpr } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IMemoriesService } from '../../../../platform/memories/common/memoriesService.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { MemoriesViewPane } from './memoriesViewPane.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.memories', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Memories accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Memories accessibility help', description: 'Announce the keyboard help hint when the memories view receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.memories', WorkbenchPhase.BlockStartup, accessor => {
	const registrations = new DisposableStore();
	if (!accessor.getOptional(IMemoriesService)) { return registrations; }
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.memories', title: 'Memories', location: ViewContainerLocation.Panel, order: 4 }));
	registrations.add(ViewsRegistry.registerViews('ash.memories', [{ id: 'ash.memories.view', title: 'Memories', canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(MemoriesViewPane, { serviceDependencies: [IMemoriesService, IChatSessionNavigationService, IDialogService, IConfigurationService, IContextKeyService] }) }]));
	registrations.add(registerAction2(class OpenMemories extends Action2 {
		constructor() { super({ id: 'ash.memories.open', title: 'Open memories', f1: true }); }
		public override run(services: ServicesAccessor): void { services.get(IViewsService).focusView('ash.memories.view'); }
	}));
	registrations.add(registerAction2(class SaveMemory extends Action2 {
		constructor() { super({ id: 'ash.memories.save', title: 'Save memory', keybinding: { primary: Keybinding.single(logicalKey('s', { primaryKey: true })), when: ContextKeyExpr.has(MemoriesViewPane.FocusContext), priority: 1000 } }); }
		public override async run(services: ServicesAccessor): Promise<void> {
			const view = services.get(IViewsService).openView('ash.memories.view');
			if (view instanceof MemoriesViewPane) { await view.saveDraft(); }
		}
	}));
	registrations.add(registerAction2(class OpenMemoryReference extends Action2 {
		constructor() { super({ id: 'ash.memories.openReference', title: 'Open memory reference' }); }
		public override async run(services: ServicesAccessor, reference: string): Promise<void> {
			const view = services.get(IViewsService).openView('ash.memories.view');
			if (view instanceof MemoriesViewPane) { await view.openReference(reference); }
		}
	}));
	return registrations;
});
