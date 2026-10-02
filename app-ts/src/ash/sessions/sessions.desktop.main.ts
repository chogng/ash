import '../workbench/electron-browser/desktop.contribution.js';
import './sessions.common.main.js';
import './browser/parts/menubar.contribution.js';
import './contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js';
import { registerOpenAgentsWindowCommand } from './contrib/openAgentsWindow/electron-browser/openAgentsWindowCommand.js';
import { localizedString } from '../platform/action/common/action.js';
import { MenusRegistry } from '../platform/actions/common/actions.js';
import { Menus } from './browser/menus.js';

registerOpenAgentsWindowCommand();

MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: { id: 'workbench.action.closeWindow', title: localizedString('ash', 'workbench.closeWindow', 'Close Window') },
	group: '6_close',
	order: 5,
});
