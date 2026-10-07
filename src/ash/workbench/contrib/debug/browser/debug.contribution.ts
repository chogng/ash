import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { DebugTitleContribution } from './debugTitle.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { BREAKPOINT_EDITOR_CONTRIBUTION_ID, CONTEXT_DISASSEMBLY_VIEW_FOCUS, DEBUG_CONSOLE_VIEW_ID, DEBUG_VIEW_ID, DISASSEMBLY_VIEW_ID } from "../common/debug.js";
import { DebugViewPane } from "./debugViewPane.js";
import { DebugConsoleViewPane } from "./debugConsoleViewPane.js";
import { BreakpointEditorContribution } from "./breakpointEditorContribution.js";
import { EditorContributionInstantiation, registerEditorContribution } from "../../../../editor/browser/editorExtensions.js";
import { localize } from '../../../../nls.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { DisassemblyView } from './disassemblyView.js';
import './debugActions.js';
import './debugService.js';
import './media/debug.css';

registerEditorPane({
	id: DISASSEMBLY_VIEW_ID,
	name: localize('debug.disassembly', 'Disassembly'),
	canOpen: input => input.editorId === DISASSEMBLY_VIEW_ID ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(DisassemblyView),
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 110, name: `debug.disassembly.${type}`, when: CONTEXT_DISASSEMBLY_VIEW_FOCUS.isEqualTo(true),
		getProvider: accessor => {
			const view = accessor.get(IEditorPartsService).activePane?.getControl?.();
			if (!(view instanceof DisassemblyView)) { return undefined; }
			const focused = view.domNode.ownerDocument.activeElement as HTMLElement | null;
			const provider = new AccessibleContentProvider(AccessibleViewProviderId.Disassembly, { type },
				() => type === AccessibleViewType.View ? view.getAccessibleContent() : localize('debug.disassemblyHelp', 'Disassembly\nUse Up and Down to select an instruction. Press F9 to toggle its instruction breakpoint. Press Enter to open the instruction source. Use Previous instructions and Next instructions to change pages. Enter an address and activate Go to address, or activate Current instruction to return to the paused frame.\nStep Over (<keybinding:workbench.action.debug.stepOver>), Step Into (<keybinding:workbench.action.debug.stepInto>), and Step Out (<keybinding:workbench.action.debug.stepOut>) operate on instructions when this editor is active and the adapter supports instruction stepping.\nOpen Accessible View to read the loaded instructions. Press Escape to close this dialog and return to the editor.'),
				() => { if (focused?.isConnected) { focused.focus(); } else { view.focus(); } }, AccessibilityVerbositySettingId.Disassembly);
			if (type === AccessibleViewType.View) { provider.onDidChangeContent = view.onDidChangeContent; }
			return provider;
		},
	});
}

export function registerDebugView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Debug, title: "Run and Debug", localizationKey: { bundle: "ash.views", key: "runAndDebug" }, location: ViewContainerLocation.Sidebar, icon: Lxicon.debugAlt, order: 3 });
	registry.registerStaticViews(WorkbenchViewContainerId.Debug, [{ id: DEBUG_VIEW_ID, title: "Run and Debug", localizationKey: { bundle: "ash.views", key: "runAndDebug" }, order: 1, canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(DebugViewPane) }]);
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.DebugConsole, title: "Debug Console", localizationKey: { bundle: "ash.views", key: "debugConsole" }, location: ViewContainerLocation.Panel, order: 2.75 });
	registry.registerStaticViews(WorkbenchViewContainerId.DebugConsole, [{ id: DEBUG_CONSOLE_VIEW_ID, title: "Debug Console", localizationKey: { bundle: "ash.views", key: "debugConsole" }, order: 1, canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(DebugConsoleViewPane) }]);
}

registerDebugView();
registerEditorContribution({
	id: BREAKPOINT_EDITOR_CONTRIBUTION_ID,
	instantiation: EditorContributionInstantiation.Eager,
	install: context => {
		if (context.kind !== 'text') return;
		return context.instantiationService.createInstance(BreakpointEditorContribution, context.editor, context.model);
	},
});

registerWorkbenchContribution('workbench.contrib.debugTitle', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugTitleContribution));
