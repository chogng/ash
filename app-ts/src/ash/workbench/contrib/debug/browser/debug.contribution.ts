import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IDebugService } from "../../../services/debug/common/debugService.js";
import { IDebugConsoleService } from "../../../services/debug/common/debugConsoleService.js";
import { BREAKPOINT_EDITOR_CONTRIBUTION_ID, DEBUG_CONSOLE_VIEW_ID, DEBUG_VIEW_ID } from "../common/debug.js";
import { DebugViewPane } from "./debugViewPane.js";
import { DebugConsoleViewPane } from "./debugConsoleViewPane.js";
import { BreakpointEditorContribution } from "./breakpointEditorContribution.js";
import { EditorContributionInstantiation, registerEditorContribution } from "../../../../editor/browser/editorExtensions.js";
import "./debugActions.js";
import "./media/debug.css";

export function registerDebugView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Debug, title: "Run and Debug", localizationKey: { bundle: "ash.views", key: "runAndDebug" }, location: ViewContainerLocation.Sidebar, icon: lxiconsLibrary.start, order: 3 });
	registry.registerStaticViews(WorkbenchViewContainerId.Debug, [{ id: DEBUG_VIEW_ID, title: "Run and Debug", localizationKey: { bundle: "ash.views", key: "runAndDebug" }, order: 1, canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(DebugViewPane, { serviceDependencies: [IDebugService, IEditorService] }) }]);
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.DebugConsole, title: "Debug Console", localizationKey: { bundle: "ash.views", key: "debugConsole" }, location: ViewContainerLocation.Panel, order: 2.75 });
	registry.registerStaticViews(WorkbenchViewContainerId.DebugConsole, [{ id: DEBUG_CONSOLE_VIEW_ID, title: "Debug Console", localizationKey: { bundle: "ash.views", key: "debugConsole" }, order: 1, canToggleVisibility: false, ctorDescriptor: new ServiceConstructionDescriptor(DebugConsoleViewPane, { serviceDependencies: [IDebugConsoleService] }) }]);
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
