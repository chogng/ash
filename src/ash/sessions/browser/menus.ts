import { MenuId } from '../../platform/actions/common/actions.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export const Menus = {
	ActivityBar: new MenuId('SessionsActivityBar'),
	ActivityBarContext: new MenuId('SessionsActivityBarContext'),
	ActivityBarPosition: new MenuId('SessionsActivityBarPosition'),
	SessionActivityBar: new MenuId('SessionActivityBar'),
	SessionActivityBarContext: new MenuId('SessionActivityBarContext'),
	CustomViewAutomations: new MenuId('CustomViewAutomations'),
	CustomViewScheduled: new MenuId('CustomViewScheduled'),
	CustomViewCanvas: new MenuId('CustomViewCanvas'),
	SidebarChatSessionContext: new MenuId('SidebarChatSessionContext'),
	SidebarCodeSessionContext: new MenuId('SidebarCodeSessionContext'),
	SidebarChatProjectContext: new MenuId('SidebarChatProjectContext'),
	SidebarChatProjectFileContext: new MenuId('SidebarChatProjectFileContext'),
	SidebarCodeProjectContext: new MenuId('SidebarCodeProjectContext'),
	SessionSectionToolbar: new MenuId('SessionSectionToolbar'),
	SidebarSessionsHeader: new MenuId('SidebarSessionsHeader'),
	SidebarTitle: new MenuId('SessionsSidebarTitle'),
	SidebarFooter: new MenuId('SessionsSidebarFooter'),
	AccountMenu: new MenuId('SessionsAccountMenu'),
	SessionsViewFilter: new MenuId('SessionsViewPaneFilterSubMenu'),
	NewSessionChatInputToolbar: new MenuId('NewSessionChatInputToolbar'),
	ArtifactToolbar: new MenuId('ArtifactToolbar'),
	ArtifactContext: new MenuId('ArtifactContext'),
	ArtifactTitleBar: new MenuId('ArtifactTitleBar'),
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	TitleBarContext: new MenuId('SessionsTitleBarContext'),
	CommandCenter: new MenuId('SessionsCommandCenter'),
	TitleBarPageContent: new MenuId('SessionsTitleBarPageContent'),
	TitleBarRightLayout: new MenuId('SessionsTitleBarRightLayout'),
	TitleBarAccounts: new MenuId('SessionsTitleBarAccounts'),
	TitleBarSidePane: new MenuId('SessionsTitleBarSidePane'),
	SessionTitleBar: new MenuId('SessionsSessionTitleBar'),
	EditorPartLayout: new MenuId('SessionsEditorPartLayout'),
	EmptyFileEditorActions: new MenuId('SessionsEmptyFileEditorActions'),
	SessionsEditorTabsBarAddTab: new MenuId('SessionsEditorTabsBarAddTab'),
	SessionsEmptyEditorGroupAddTab: new MenuId('SessionsEmptyEditorGroupAddTab'),
	SessionsEditorHeaderPrimary: new MenuId('SessionsEditorHeaderPrimary'),
	SessionsEditorHeaderLayout: new MenuId('SessionsEditorHeaderLayout'),
	SessionsChangesScope: new MenuId('SessionsChangesScope'),
	SessionsTerminalSplit: new MenuId('SessionsTerminalSplit'),
	SessionsEditorTitle: new MenuId('SessionsEditorTitle'),
	SessionsEditorTabsBarAddTabCanvas: new MenuId('SessionsEditorTabsBarAddTabCanvas'),
} as const;

export const activityBarPositionCommandPrefix = 'sessions.action.activityBar.position.';

export const SessionActivityBarVisibleContext = new RawContextKey<boolean>('sessions.sessionActivityBarVisible', false);
export const SessionsFlatLayoutContext = new RawContextKey<boolean>('sessions.flatLayout', false);
export const EditorHasMultipleToolsContext = new RawContextKey<boolean>('sessions.editorHasMultipleTools', false);
