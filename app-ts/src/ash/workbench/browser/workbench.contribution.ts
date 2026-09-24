import {
	IKeybindingsResourceService,
} from "../../platform/keybinding/common/keybindingsResource.js";
import {
	registerWorkbenchContribution,
	WorkbenchPhase,
} from "../common/contributions.js";
import {
	ViewContainerLocation,
	WorkbenchViewContainerId,
	ViewsRegistry,
} from "../common/views.js";
import {
	KeybindingsResourceContribution,
} from "../services/keybinding/browser/keybindingsResourceContribution.js";
import {
	registerFilesViews,
} from "../contrib/files/browser/files.contribution.js";
import {
	registerGitViews,
} from "../contrib/scm/browser/scm.contribution.js";
import {
	registerSearchViews,
} from "../contrib/search/browser/search.contribution.js";
import {
	registerChatViews,
} from "../contrib/chat/browser/chat.contribution.js";
import { registerPanelViews } from "../contrib/panel/browser/panel.contribution.js";
import { registerProblemsView } from "../contrib/problems/browser/problems.contribution.js";
import { registerTerminalView } from "../contrib/terminal/browser/terminal.contribution.js";
import { lxiconsLibrary } from "../../base/common/lxiconsLibrary.js";
import "../contrib/bulkEdit/browser/bulkEdit.contribution.js";
import "../contrib/binaryEditor/browser/binaryEditor.contribution.js";
import "../contrib/markdown/browser/markdown.contribution.js";
import "../contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js";
import "../contrib/pdf/browser/pdf.contribution.js";
import "../contrib/preferences/browser/preferences.contribution.js";
import "../contrib/quickaccess/browser/commandsQuickAccess.js";
import "../contrib/quickaccess/browser/workspaceSymbolsQuickAccess.js";
import { registerRemoteViews } from "../contrib/remote/browser/remote.contribution.js";
import "../contrib/sash/browser/sash.contribution.js";
import "./parts/dialogs/dialog.contribution.js";
import "./parts/editor/editorActions.js";
import { EditorStatusContribution } from "./parts/editor/editorStatus.js";
import { IEditorPart } from "./parts/editor/editorPart.js";
import { IStatusbarService } from "../services/statusbar/browser/statusbar.js";
import { EditorAutoSaveContribution } from "./parts/editor/editorAutoSave.js";
import { IWorkingCopyService } from "../services/workingCopy/common/workingCopyService.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import "./parts/titlebar/menubar.contribution.js";
import "./parts/titlebar/titlebarActions.js";

ViewsRegistry.registerStaticViewContainer({
	id: WorkbenchViewContainerId.Sidebar,
	title: "Explorer",
	localizationKey: { bundle: "ash.views", key: "explorer" },
	location: ViewContainerLocation.Sidebar,
	icon: lxiconsLibrary.files,
	order: 1,
	isDefault: true,
});
registerFilesViews();
registerSearchViews();
registerGitViews();
registerChatViews();
registerProblemsView();
registerPanelViews();
registerRemoteViews();
registerTerminalView();

registerWorkbenchContribution(
	"workbench.contrib.keybindingsResource",
	WorkbenchPhase.BlockRestore,
	(accessor) => new KeybindingsResourceContribution({
		service: accessor.get(IKeybindingsResourceService),
	}),
);

registerWorkbenchContribution(
	"workbench.contrib.editorStatus",
	WorkbenchPhase.AfterRestored,
	(accessor) => new EditorStatusContribution(
		accessor.get(IEditorPart),
		accessor.get(IStatusbarService),
	),
);

registerWorkbenchContribution(
	"workbench.contrib.editorAutoSave",
	WorkbenchPhase.AfterRestored,
	(accessor) => new EditorAutoSaveContribution(
		accessor.get(IEditorPart),
		accessor.get(IWorkingCopyService),
		accessor.get(IConfigurationService),
	),
);
