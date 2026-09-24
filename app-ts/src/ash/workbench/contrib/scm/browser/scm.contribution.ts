import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { IMenuService } from "../../../../platform/actions/common/menuService.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IHoverService } from "../../../../platform/hover/browser/hoverService.js";
import { IFileIconThemeService } from "../../../../platform/theme/browser/fileIconThemeService.js";
import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IGitService } from "../../../services/git/common/gitService.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { ScmAgentReviewViewPane } from "./scmAgentReviewViewPane.js";
import { ScmGraphViewPane } from "./scmGraphViewPane.js";
import { GIT_GRAPH_VIEW_ID } from "./scmGraphTitleActions.js";
import { ScmStatusContribution } from "./scmStatus.js";
import { GIT_VIEW_ID, ScmViewPane } from "./scmViewPane.js";
import "./media/scm.css";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IEditorPart } from "../../../browser/parts/editor/editorPart.js";
import { ScmWorkingSetController } from "./workingSet.js";
import { ScmHistoryChatContextContribution } from "./scmHistoryChatContext.js";
import { IChatContextPickService } from "../../../services/chat/common/chatContextService.js";
import "../common/scmConfiguration.js";
import "./quickDiff.contribution.js";

export const GIT_AGENT_REVIEW_VIEW_ID = "ash.gitAgentReview";
export { GIT_GRAPH_VIEW_ID };
export { GIT_VIEW_ID };

/** Registers the Git Sidebar container and its initial pane. */
export function registerGitViews(
	registry: WorkbenchViewRegistry = ViewsRegistry,
): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Git,
		title: "Git",
		localizationKey: { bundle: "ash.views", key: "git" },
		location: ViewContainerLocation.Sidebar,
		icon: lxiconsLibrary.gitBranch,
		order: 3,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Git, [
		{
			id: GIT_VIEW_ID,
			title: "Changes",
			localizationKey: { bundle: "ash.views", key: "changes" },
			order: 1,
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(ScmViewPane, {
				serviceDependencies: [IGitService, IFileIconThemeService, IEditorService, ICommandService, IContextMenuService],
			}),
		},
		{
			id: GIT_AGENT_REVIEW_VIEW_ID,
			title: "Agent Review",
			localizationKey: { bundle: "ash.views", key: "agentReview" },
			order: 2,
			collapsed: true,
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(ScmAgentReviewViewPane),
		},
		{
			id: GIT_GRAPH_VIEW_ID,
			title: "Graph",
			localizationKey: { bundle: "ash.views", key: "graph" },
			order: 3,
			collapsed: true,
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(ScmGraphViewPane, {
				serviceDependencies: [IGitService, IMenuService, IContextMenuService, IContextKeyService, IHoverService, IEditorService, IFileIconThemeService],
			}),
		},
	]);
}

registerWorkbenchContribution("workbench.contrib.scmStatus", WorkbenchPhase.BlockRestore, accessor => new ScmStatusContribution({
	statusbarService: accessor.get(IStatusbarService),
	gitService: accessor.get(IGitService),
	viewsService: accessor.get(IViewsService),
}));

registerWorkbenchContribution("workbench.contrib.scmWorkingSets", WorkbenchPhase.BlockRestore, accessor => new ScmWorkingSetController({
	configurationService: accessor.get(IConfigurationService),
	editorPart: accessor.get(IEditorPart),
	gitService: accessor.get(IGitService),
	storageService: accessor.get(IStorageService),
}));

registerWorkbenchContribution("workbench.contrib.scmHistoryChatContext", WorkbenchPhase.BlockRestore, accessor => new ScmHistoryChatContextContribution(
	accessor.get(IChatContextPickService),
	accessor.get(IGitService),
));
