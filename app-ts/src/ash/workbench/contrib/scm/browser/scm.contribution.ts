import { Lxicon } from "../../../../base/common/lxicons.js";
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IHoverService } from "../../../../platform/hover/browser/hoverService.js";
import { IResourceIconRenderer } from "../../../browser/labels.js";
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { ScmAgentReviewViewPane } from "./scmAgentReviewViewPane.js";
import { SCMHistoryViewPane } from "./scmHistoryViewPane.js";
import { ScmStatusContribution } from "./scmStatus.js";
import { GIT_VIEW_ID, ScmViewPane } from "./scmViewPane.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IEditorPart } from "../../../browser/parts/editor/editorPart.js";
import { ScmWorkingSetController } from "./workingSet.js";
import { ScmHistoryChatContextContribution } from "./scmHistoryChatContext.js";
import { SCMViewPaneContainer } from './scmViewPaneContainer.js';
import { IChatContextPickService } from "../../../services/chat/common/chatContextService.js";
import "../common/scmConfiguration.js";
import "./quickDiff.contribution.js";
import { localize } from '../../../../nls.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import type { EditorPanePartOptions } from '../../../browser/parts/editor/textResourceEditor.js';
import { getBrowserTextResourceStore } from '../../codeEditor/browser/browserTextResourceStore.js';
import { createBrowserEditorPart } from '../../codeEditor/browser/browserEditorPart.js';
import { matchScmMergeEditor, SCM_MERGE_EDITOR_ID } from './scmMergeEditorInput.js';
import { ScmMergeEditorPane, ScmMergeFocusedContext } from './scmMergeEditorPane.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import './media/scmMergeEditor.css';
import './scm.service.contribution.js';
import { ISCMService, ISCMViewService, SCMHistoryBusyContext } from '../common/scm.js';

export const GIT_AGENT_REVIEW_VIEW_ID = "ash.gitAgentReview";
export const GIT_GRAPH_VIEW_ID = 'ash.gitGraph';
export { GIT_VIEW_ID };

registerAction2(class SCMHistoryRefreshAction extends Action2 {
	constructor() {
		super({
			id: 'ash.git.graph.refresh',
			title: 'Refresh',
			tooltip: 'Refresh SCM history',
			icon: Lxicon.refresh,
			precondition: SCMHistoryBusyContext.isEqualTo(false),
			menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 4 },
		});
	}

	override async run(_accessor: ServicesAccessor, target: unknown): Promise<void> {
		if (target instanceof SCMHistoryViewPane) await target.runTitleOperation();
	}
});

registerEditorPane({
	id: SCM_MERGE_EDITOR_ID,
	name: localize({ bundle: 'ash', key: 'git.mergeTitle' }, 'Resolve merge conflict'),
	canOpen: matchScmMergeEditor,
	create: options => {
		if (!options.textFileService || !options.instantiationService) throw new Error('SCM merge editor requires the text file and instantiation services');
		const instantiationService = options.instantiationService;
		const resultEditor = instantiationService.createInstance(TextFileEditor, getBrowserTextResourceStore(options.textFileService), {
			createPart: (partOptions: EditorPanePartOptions) => createBrowserEditorPart(instantiationService, partOptions),
			minimap: { enabled: false },
			workingCopyService: options.workingCopyService,
			accessibilityService: options.accessibilityService,
			textMateService: options.textMateService,
			languageDiagnosticsService: options.languageDiagnosticsService,
		});
		return instantiationService.createInstance(ScmMergeEditorPane, resultEditor);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'scmMergeHelp',
	when: ScmMergeFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof ScmMergeEditorPane)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.ScmMerge,
			{ type: AccessibleViewType.Help },
			() => localize({ bundle: 'ash', key: 'git.mergeHelp' }, 'Merge editor. Review aligned Current, Incoming, and Result editors. Show Base reveals the common ancestor; Use Columns changes the layout. Actions beside each conflict accept Base, Current, Incoming, or a combination. Mark Handled confirms a result that was already edited; Mark Unhandled returns it to the review list. Navigate all conflicts or only unresolved conflicts with the buttons above, or accept all remaining conflicts from one side. You can also edit Result directly. For deleted or binary versions, choose the whole file. Save with Ctrl+S or Command+S. Complete Merge saves and stages the result after every conflict is handled and all conflict markers are removed. Press <keybinding:editor.action.accessibleView> to read all four versions.'),
			() => pane.focus(),
			AccessibilityVerbositySettingId.ScmMerge,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'scmMergeView',
	when: ScmMergeFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof ScmMergeEditorPane)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.ScmMerge,
			{ type: AccessibleViewType.View },
			() => pane.getAccessibleContent(),
			() => pane.focus(),
			AccessibilityVerbositySettingId.ScmMerge,
		);
	},
});

/** Registers the Git Sidebar container and its initial pane. */
export function registerGitViews(
	registry: WorkbenchViewRegistry = ViewsRegistry,
): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Git,
		title: "Git",
		localizationKey: { bundle: "ash.views", key: "git" },
		location: ViewContainerLocation.Sidebar,
		ctorDescriptor: new ServiceConstructionDescriptor(SCMViewPaneContainer),
		icon: Lxicon.gitBranch,
		order: 3,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Git, [
		{
			id: GIT_VIEW_ID,
			title: "Changes",
			localizationKey: { bundle: "ash.views", key: "changes" },
			order: 1,
			canToggleVisibility: false,
			ctorDescriptor: new ServiceConstructionDescriptor(ScmViewPane),
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
			ctorDescriptor: new ServiceConstructionDescriptor(SCMHistoryViewPane, {
				serviceDependencies: [ISCMViewService, IMenuService, IContextMenuService, IContextKeyService, IHoverService, IEditorService, IResourceIconRenderer],
			}),
		},
	]);
}

registerWorkbenchContribution("workbench.contrib.scmStatus", WorkbenchPhase.BlockRestore, accessor => new ScmStatusContribution({
	statusbarService: accessor.get(IStatusbarService),
	scmViewService: accessor.get(ISCMViewService),
}));

registerWorkbenchContribution("workbench.contrib.scmWorkingSets", WorkbenchPhase.BlockRestore, accessor => new ScmWorkingSetController({
	configurationService: accessor.get(IConfigurationService),
	editorPart: accessor.get(IEditorPart),
	scmViewService: accessor.get(ISCMViewService),
	storageService: accessor.get(IStorageService),
}));

registerWorkbenchContribution("workbench.contrib.scmHistoryChatContext", WorkbenchPhase.BlockRestore, accessor => new ScmHistoryChatContextContribution(
	accessor.get(IChatContextPickService),
	accessor.get(ISCMService),
));
