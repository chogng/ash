import { MenuId } from '../../platform/actions/common/actions.js';

export const Menus = {
	ActivityBar: new MenuId('SessionsActivityBar'),
	CodeActivityBar: new MenuId('SessionsCodeActivityBar'),
	ActivityBarContext: new MenuId('SessionsActivityBarContext'),
	CustomViewAutomations: new MenuId('CustomViewAutomations'),
	SidebarSessionsHeader: new MenuId('SidebarSessionsHeader'),
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	TitleBarRightLayout: new MenuId('SessionsTitleBarRightLayout'),
	CodeAddTab: new MenuId('SessionsAddTab'),
	ChatSessionsLayout: new MenuId('chatAgentSessionsOrientationSubmenu'),
} as const;
