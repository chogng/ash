import { TerminalEditingService } from './terminalEditingService.js';
import { terminalStrings } from '../common/terminalStrings.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';
import { TerminalEditor } from './terminalEditor.js';
import { TerminalEditorInput } from './terminalEditorInput.js';
import { TerminalInputSerializer } from './terminalEditorSerializer.js';
import { TerminalEditorService } from './terminalEditorService.js';
import { registerTerminalActions } from './terminalActions.js';
import { setupTerminalMenus } from './terminalMenus.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, WorkbenchViewContainerId, type WorkbenchViewRegistry, ViewsRegistry } from '../../../common/views.js';
import { TERMINAL_VIEW_ID } from '../common/terminal.js';
import { TerminalViewPane } from './terminalView.js';
import { ITerminalLogService, ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { TerminalLogService } from '../../../../platform/terminal/common/terminalLogService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { ITerminalConfigurationService } from './terminal.js';
import { ITerminalService, ITerminalGroupService, ITerminalEditorService, ITerminalEditingService } from './terminal.js';
import { TerminalGroupService } from './terminalGroupService.js';
import { setupTerminalCommands } from './terminalCommands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITerminalContributionService, ITerminalProfileService } from '../common/terminal.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TerminalConfigurationService } from './terminalConfigurationService.js';
import { TerminalProfileService } from './terminalProfileService.js';
import { TerminalService } from './terminalService.js';
import { TerminalMainContribution } from './terminalMainContribution.js';
import { AgentHostOutputChannel } from './agentHostOutputChannel.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

// Ash creates its view services with the Parts; host terminal requests need both owners ready.
registerWorkbenchContribution(TerminalMainContribution.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(TerminalMainContribution));
registerWorkbenchContribution(AgentHostOutputChannel.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(AgentHostOutputChannel));

// Register the owner before resolving its delayed group/editor services, which
// depend on it in turn. Their constructors run only after the owner is available.
registerSingleton(ITerminalService, TerminalService, InstantiationType.Delayed);

registerWorkbenchServiceContribution({
	service: ITerminalConfigurationService,
	dependencies: [IConfigurationService],
	install: context => context.register(context.container.createInstance(TerminalConfigurationService)),
});

registerSingleton(ITerminalGroupService, TerminalGroupService, InstantiationType.Delayed);
registerSingleton(ITerminalLogService, TerminalLogService, InstantiationType.Delayed);

registerWorkbenchServiceContribution({
	service: ITerminalProfileService,
	dependencies: [ITerminalProcessService, IConfigurationService, IWorkspaceContextService, IExtensionService, ITerminalContributionService],
	install: context => context.register(context.container.createInstance(TerminalProfileService)),
});

export { TERMINAL_VIEW_ID } from '../common/terminal.js';

registerTerminalActions();
setupTerminalCommands();
setupTerminalMenus();

/** Registers the integrated terminal in the Workbench panel. */
export function registerTerminalView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Terminal,
		title: 'Terminal',
		localizationKey: { bundle: 'ash.views', key: 'terminal' },
		location: ViewContainerLocation.Panel,
		order: 3,
		isDefault: true,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Terminal, [
		{
			id: TERMINAL_VIEW_ID,
			title: 'Terminal',
			localizationKey: { bundle: 'ash.views', key: 'terminal' },
			order: 1,
			canToggleVisibility: false,
			canMoveView: true,
			ctorDescriptor: new SyncDescriptor(TerminalViewPane),
		},
	]);
}

registerSingleton(ITerminalEditorService, TerminalEditorService, InstantiationType.Delayed);
EditorInputSerializers.registerStatic(new TerminalInputSerializer());
registerEditorPane({
	id: TerminalEditorInput.ID,
	name: terminalStrings.terminal,
	canOpen: input => (input instanceof TerminalEditorInput ? EditorPaneMatch.Default : EditorPaneMatch.None),
	create: options => {
		if (!options.instantiationService) throw new Error('Terminal editor requires the window service container');
		return options.instantiationService.createInstance(TerminalEditor);
	},
});

registerSingleton(ITerminalEditingService, TerminalEditingService, InstantiationType.Delayed);
