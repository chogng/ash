import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { Event } from '../../../../base/common/event.js';
import { IContextMenuService } from '../../../contextview/browser/contextView.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { IActionViewItemService } from '../../browser/actionViewItemService.js';
import { IMenuService } from '../../common/actions.js';

export function createTestMenuToolbarServices(menus: IMenuService, contextMenus: IContextMenuProvider, parent?: InstantiationService): InstantiationService {
	const presentations = getSingletonServiceDescriptors().find(([id]) => id === IActionViewItemService)!;
	const registrations = new ServiceCollection(presentations, [IMenuService, menus], [IContextMenuService, {
		contextMenuStyle: 'custom',
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: delegate => contextMenus.showContextMenu({ ...delegate, getActions: delegate.getActions ?? (() => []) }),
		hideContextMenu() { },
	} satisfies IContextMenuService]);
	return parent ? parent.createChild(registrations) : new InstantiationService(registrations);
}
