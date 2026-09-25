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
} from "../contrib/files/browser/explorerViewlet.js";
import '../contrib/files/browser/files.contribution.js';
import '../contrib/accessibility/browser/accessibility.contribution.js';
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
import { Lxicon } from "../../base/common/lxicons.js";
import { registerAction2 } from '../../platform/actions/common/actions.js';
import { OpenFolderAction, OpenFolderViaWorkspaceAction } from './actions/workspaceActions.js';
import "../contrib/bulkEdit/browser/bulkEdit.contribution.js";
import "../contrib/binaryEditor/browser/binaryEditor.contribution.js";
import "../contrib/markdown/browser/markdown.contribution.js";
import "../contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js";
import "../contrib/pdf/browser/pdf.contribution.js";
import "../contrib/preferences/browser/preferences.contribution.js";
import "../contrib/quickaccess/browser/quickAccess.contribution.js";
import "../contrib/welcomeGettingStarted/browser/gettingStarted.contribution.js";
import "../contrib/search/browser/searchQuickAccess.contribution.js";
import { registerRemoteViews } from "../contrib/remote/browser/remote.contribution.js";
import "../contrib/sash/browser/sash.contribution.js";
import "./parts/dialogs/dialog.web.contribution.js";
import "./parts/editor/editor.contribution.js";
import "./parts/titlebar/menubar.contribution.js";
import "./parts/titlebar/titlebarActions.js";

ViewsRegistry.registerStaticViewContainer({
	id: WorkbenchViewContainerId.Sidebar,
	title: "Explorer",
	localizationKey: { bundle: "ash.views", key: "explorer" },
	location: ViewContainerLocation.Sidebar,
	icon: Lxicon.files,
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
registerAction2(OpenFolderAction);
registerAction2(OpenFolderViaWorkspaceAction);

registerWorkbenchContribution(
	"workbench.contrib.keybindingsResource",
	WorkbenchPhase.BlockRestore,
	(accessor) => new KeybindingsResourceContribution({
		service: accessor.get(IKeybindingsResourceService),
	}),
);
