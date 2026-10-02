import { MenuId } from '../../platform/actions/common/actions.js';

export const Menus = {
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	CodeAddTab: new MenuId('SessionsAddTab'),
	NewSessionControl: new MenuId('NewSessions.SessionControlMenu'),
} as const;
