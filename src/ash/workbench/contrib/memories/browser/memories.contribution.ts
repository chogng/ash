import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { ContextKeyExpr } from "../../../../platform/contextkey/common/contextkey.js";
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IMemoriesService } from '../../../../platform/memories/common/memoriesService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
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
	registrations.add(ViewsRegistry.registerViews('ash.memories', [{ id: 'ash.memories.view', title: 'Memories', canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(MemoriesViewPane) }]));
	registrations.add(AccessibleViewRegistry.register({
		type: AccessibleViewType.Help, priority: 100, name: 'memoriesHelp',
		when: FocusedViewContext.isEqualTo('ash.memories.view'),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).getViewWithId('ash.memories.view');
			if (!(view instanceof MemoriesViewPane)) { return undefined; }
			const focused = view.element.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.Memories, { type: AccessibleViewType.Help },
				() => localize('memories.help', 'Choose a conversation context and memory scope. Reading and model saving are independent permissions and start disabled. Use Tab and Shift+Tab to move between controls, arrow keys to browse the list, and Ctrl or Command+S to save. Memory content is plain text and can be selected and copied. Open reference shows an exact, read-only excerpt. Editing a model memory gives you ownership and prevents later model overwrites. Escape closes this help dialog.'),
				() => { if (focused instanceof HTMLElement && focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.Memories);
		},
	}));
	registrations.add(registerAction2(class OpenMemories extends Action2 {
		constructor() { super({ id: 'ash.memories.open', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenMemories' }, 'Open memories'), f1: true }); }
		public override run(services: ServicesAccessor): Promise<boolean> { return services.get(IViewsService).focusView('ash.memories.view'); }
	}));
	registrations.add(registerAction2(class SaveMemory extends Action2 {
		constructor() { super({ id: 'ash.memories.save', title: localize2({ bundle: 'ash.workbench', key: 'command.SaveMemory' }, 'Save memory'), keybinding: { primary: Keybinding.single(logicalKey('s', { primaryKey: true })), when: ContextKeyExpr.has(MemoriesViewPane.FocusContext), priority: 1000 } }); }
		public override async run(services: ServicesAccessor): Promise<void> {
			const view = await services.get(IViewsService).openView('ash.memories.view');
			if (view instanceof MemoriesViewPane) { await view.saveDraft(); }
		}
	}));
	registrations.add(registerAction2(class OpenMemoryReference extends Action2 {
		constructor() { super({ id: 'ash.memories.openReference', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenMemoryReference' }, 'Open memory reference') }); }
		public override async run(services: ServicesAccessor, reference: string): Promise<void> {
			const view = await services.get(IViewsService).openView('ash.memories.view');
			if (view instanceof MemoriesViewPane) { await view.openReference(reference); }
		}
	}));
	return registrations;
});
