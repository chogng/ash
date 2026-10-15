import { MenuId } from '../../platform/actions/common/actions.js';

export const Menus = {
	ActivityBar: new MenuId('SessionsActivityBar'),
	ActivityBarContext: new MenuId('SessionsActivityBarContext'),
	CustomViewAutomations: new MenuId('CustomViewAutomations'),
	SidebarSessionsHeader: new MenuId('SidebarSessionsHeader'),
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	CodeAddTab: new MenuId('SessionsAddTab'),
	ChatSessionsLayout: new MenuId('chatAgentSessionsOrientationSubmenu'),
} as const;
