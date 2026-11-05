import { MenuId } from '../../platform/actions/common/actions.js';

export const Menus = {
	ActivityBar: new MenuId('SessionsActivityBar'),
	CodeActivityBar: new MenuId('SessionsCodeActivityBar'),
	ActivityBarContext: new MenuId('SessionsActivityBarContext'),
	CustomViewAutomations: new MenuId('CustomViewAutomations'),
	CustomViewCanvas: new MenuId('CustomViewCanvas'),
	SidebarSessionContext: new MenuId('SidebarSessionContext'),
	SidebarSessionsHeader: new MenuId('SidebarSessionsHeader'),
	SessionsViewFilter: new MenuId('SessionsViewPaneFilterSubMenu'),
	NewSessionChatInputToolbar: new MenuId('NewSessionChatInputToolbar'),
	ChatSidebarHeader: new MenuId('ChatSidebarHeader'),
	SessionsViewSort: new MenuId('SessionsViewSort'),
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	TitleBarRightLayout: new MenuId('SessionsTitleBarRightLayout'),
	CodeAddTab: new MenuId('SessionsAddTab'),
	SessionsEditorHeaderPrimary: new MenuId('SessionsEditorHeaderPrimary'),
	SessionsEditorHeaderLayout: new MenuId('SessionsEditorHeaderLayout'),
	SessionsEditorTitle: new MenuId('SessionsEditorTitle'),
	SessionsEditorTabsBarAddTabCanvas: new MenuId('SessionsEditorTabsBarAddTabCanvas'),
} as const;
