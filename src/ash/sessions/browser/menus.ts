import { MenuId } from '../../platform/actions/common/actions.js';

export const Menus = {
	ActivityBar: new MenuId('SessionsActivityBar'),
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	CodeAddTab: new MenuId('SessionsAddTab'),
	ChatSessionsLayout: new MenuId('chatAgentSessionsOrientationSubmenu'),
} as const;
