import { MenuId } from '../../platform/actions/common/actions.js';

export const Menus = {
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	NewSessionControl: new MenuId('NewSessions.SessionControlMenu'),
} as const;
