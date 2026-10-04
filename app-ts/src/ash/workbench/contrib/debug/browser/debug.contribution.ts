import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { DebugTitleContribution } from './debugTitle.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { BREAKPOINT_EDITOR_CONTRIBUTION_ID, DEBUG_CONSOLE_VIEW_ID, DEBUG_VIEW_ID } from "../common/debug.js";
import { DebugViewPane } from "./debugViewPane.js";
import { DebugConsoleViewPane } from "./debugConsoleViewPane.js";
import { BreakpointEditorContribution } from "./breakpointEditorContribution.js";
import { EditorContributionInstantiation, registerEditorContribution } from "../../../../editor/browser/editorExtensions.js";
import "./debugActions.js";
import "./media/debug.css";

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
