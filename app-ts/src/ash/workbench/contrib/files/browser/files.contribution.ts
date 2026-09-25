import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ContextKeyExpr } from "../../../../platform/contextkey/common/contextkey.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IResourceIconRenderer } from "../../../browser/labels.js";
import { IHoverService } from "../../../../platform/hover/browser/hoverService.js";
import { IFileLabelDecorationService } from "../../../services/labels/common/fileLabelDecorationService.js";
import { ILabelService } from "../../../../platform/label/common/labelService.js";
import { WorkspaceFolderCountContext } from "../../../common/contextkeys.js";
import { type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IWorkspaceOpenService } from "../../../services/workspaces/browser/workspaceOpenService.js";
import { ExplorerViewPane } from "./explorerViewPane.js";
import { EmptyView } from "./views/emptyView.js";
import "./media/explorer.css";

export const EXPLORER_VIEW_ID = "ash.explorer";

/** Registers the file views after the core Workbench containers exist. */
export function registerFilesViews(
	registry: WorkbenchViewRegistry = ViewsRegistry,
): void {
	registry.registerStaticViews(WorkbenchViewContainerId.Sidebar, [
		{
			id: EXPLORER_VIEW_ID,
			title: "Explorer",
			localizationKey: { bundle: "ash.views", key: "explorer" },
			order: 1,
			when: ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0),
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(ExplorerViewPane, {
				serviceDependencies: [
					IFileService,
					IWorkspaceContextService,
					IEditorService,
					IResourceIconRenderer,
					IHoverService,
					IConfigurationService,
					IFileLabelDecorationService,
					ILabelService,
				],
			}),
		},
		{
			id: EmptyView.ID,
			title: EmptyView.TITLE,
			order: 2,
			when: WorkspaceFolderCountContext.isEqualTo(0),
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(EmptyView, {
				serviceDependencies: [IWorkspaceOpenService],
			}),
		},
	]);
}
