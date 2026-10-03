import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
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
import '../contrib/git/browser/git.contribution.js';
import {
	registerGitViews,
} from "../contrib/scm/browser/scm.contribution.js";
import {
	registerSearchViews,
} from "../contrib/search/browser/search.contribution.js";
import "../contrib/chat/browser/chat.contribution.js";
import { registerPanelViews } from "../contrib/panel/browser/panel.contribution.js";
import { registerProblemsView } from "../contrib/problems/browser/problems.contribution.js";
import { registerTerminalView } from "../contrib/terminal/browser/terminal.contribution.js";
import { Lxicon } from "../../base/common/lxicons.js";
import { registerAction2 } from '../../platform/actions/common/actions.js';
import { localize } from '../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { CloseWorkspaceAction, OpenFolderAction, OpenFolderViaWorkspaceAction } from './actions/workspaceActions.js';
import { ShowAboutDialogAction } from './actions/windowActions.js';
import "../contrib/bulkEdit/browser/preview/bulkEdit.contribution.js";
import "../contrib/binaryEditor/browser/binaryEditor.contribution.js";
import "../contrib/markdown/browser/markdown.contribution.js";
import "../contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js";
import "../contrib/pdf/browser/pdf.contribution.js";
import "../contrib/preferences/browser/preferences.contribution.js";
import "../contrib/quickaccess/browser/quickAccess.contribution.js";
import "../contrib/themes/browser/themes.contribution.js";
import "../contrib/welcomeGettingStarted/browser/gettingStarted.contribution.js";
import "../contrib/search/browser/searchQuickAccess.contribution.js";
import { registerRemoteViews } from "../contrib/remote/browser/remote.contribution.js";
import "../contrib/sash/browser/sash.contribution.js";
import "./parts/dialogs/dialog.web.contribution.js";
import "./parts/editor/editor.contribution.js";
import "./parts/titlebar/menubar.contribution.js";
import "./parts/titlebar/titlebarActions.js";
import "./parts/notifications/notificationsCommands.js";

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration<boolean>({
	key: 'workbench.tips.enabled',
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Editor tips setting must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('workbench.tips.enabled.title', 'Empty editor tips'); },
		get description() { return localize('workbench.tips.enabled.description', 'Show command shortcuts when no editor is open.'); },
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration<boolean>({
	key: 'workbench.editor.restoreEditors',
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Editor restoration setting must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('workbench.editor.restoreEditors.title', 'Restore editors'); },
		get description() { return localize('workbench.editor.restoreEditors.description', 'Restore open editors and editor groups when a Workbench window reopens. Unsaved changes are restored even when this is off.'); },
	},
});

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
registerProblemsView();
registerPanelViews();
registerRemoteViews();
registerTerminalView();
registerAction2(OpenFolderAction);
registerAction2(OpenFolderViaWorkspaceAction);
registerAction2(CloseWorkspaceAction);
registerAction2(ShowAboutDialogAction);

registerWorkbenchContribution(
	"workbench.contrib.keybindingsResource",
	WorkbenchPhase.BlockRestore,
	(accessor) => accessor.get(IInstantiationService).createInstance(KeybindingsResourceContribution, {}),
);
