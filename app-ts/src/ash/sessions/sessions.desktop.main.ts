import '../workbench/electron-browser/desktop.contribution.js';
import './browser/parts/menubar.contribution.js';
import { localizedString } from '../platform/action/common/action.js';
import { MenusRegistry } from '../platform/actions/common/actions.js';
import { Menus } from './browser/menus.js';

MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: { id: 'workbench.action.closeWindow', title: localizedString('ash', 'workbench.closeWindow', 'Close Window') },
	group: '6_close',
	order: 5,
});
