import './media/actions.css';
import { Keybinding, logicalKey } from '../../../base/common/keybindings.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { localizedString } from '../../../platform/action/common/action.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { INativeHostService } from '../../common/services.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../../platform/window/common/window.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';

interface WindowPickItem extends IQuickPickItem {
	readonly windowId: number;
}

async function switchWindow(accessor: ServicesAccessor): Promise<void> {
	const host = accessor.get(INativeHostService);
	const windows = await host.listWindows();
	if (windows.length === 0) return;
	using picker = accessor.get(IQuickInputService).createQuickPick<WindowPickItem>();
	using listeners = new DisposableStore();
	picker.items = windows.map(window => ({
		windowId: window.id,
		label: window.title || localize({ bundle: 'ash', key: 'workbench.untitledWindow' }, 'Untitled Window'),
		description: window.focused ? localize({ bundle: 'ash', key: 'workbench.currentWindow' }, 'Current window') : window.parentId !== undefined ? windows.find(candidate => candidate.id === window.parentId)?.title : undefined,
		className: window.focused ? 'ash-window-switch-current' : undefined,
	}));
	picker.placeholder = localize({ bundle: 'ash', key: 'workbench.switchWindowPlaceholder' }, 'Select a window');
	picker.ariaLabel = picker.placeholder;
	const selected = new Promise<number | undefined>(resolve => {
		listeners.add(picker.onDidAccept(item => resolve(item.windowId)));
		listeners.add(picker.onDidHide(() => resolve(undefined)));
	});
	picker.show();
	const windowId = await selected;
	if (windowId !== undefined) await host.focusWindowById(windowId);
}

export class CloseWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeWindow',
			title: localizedString('ash', 'workbench.closeWindow', 'Close Window'),
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, group: '6_close', order: 4 },
			keybinding: { primary: Keybinding.single(logicalKey('w', { primaryKey: true, shiftKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).closeWindow();
	}
}

export class CloseOtherWindowsAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.closeOtherWindows', title: localizedString('ash', 'workbench.closeOtherWindows', 'Close Other Windows'), f1: true });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).closeOtherWindows();
	}
}

export class FocusWindowAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.focusWindow', title: localizedString('ash', 'workbench.focusWindow', 'Focus Window'), f1: true });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).focusWindow();
	}
}

export class ZoomInAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.zoomIn', title: localizedString('ash', 'workbench.zoomIn', 'Zoom In'), f1: true, menu: { id: MenuId.MenubarViewMenu, group: '5_zoom', order: 1 }, keybinding: { primary: Keybinding.single(logicalKey('=', { primaryKey: true })) } });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const host = accessor.get(INativeHostService);
		const level = Math.round(await host.getZoomLevel());
		if (level < 8) await host.setZoomLevel(level + 1);
	}
}

export class ZoomOutAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.zoomOut', title: localizedString('ash', 'workbench.zoomOut', 'Zoom Out'), f1: true, menu: { id: MenuId.MenubarViewMenu, group: '5_zoom', order: 2 }, keybinding: { primary: Keybinding.single(logicalKey('-', { primaryKey: true })) } });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const host = accessor.get(INativeHostService);
		const level = Math.round(await host.getZoomLevel());
		if (level > -8) await host.setZoomLevel(level - 1);
	}
}

export class ZoomResetAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.zoomReset', title: localizedString('ash', 'workbench.zoomReset', 'Reset Zoom'), f1: true, menu: { id: MenuId.MenubarViewMenu, group: '5_zoom', order: 3 }, keybinding: { primary: Keybinding.single(logicalKey('0', { primaryKey: true })) } });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).setZoomLevel(accessor.get(IConfigurationService).inspect<number>(WINDOW_ZOOM_LEVEL_SETTING).defaultValue ?? 0);
	}
}

export class SwitchWindowAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.switchWindow', title: localizedString('ash', 'workbench.switchWindow', 'Switch Window...'), f1: true });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return switchWindow(accessor);
	}
}

export class QuickSwitchWindowAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.quickSwitchWindow', title: localizedString('ash', 'workbench.quickSwitchWindow', 'Quick Switch Window'), f1: false, keybinding: { primary: Keybinding.single(logicalKey('w', { primaryKey: true, altKey: true })) } });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const host = accessor.get(INativeHostService);
		const windows = await host.listWindows();
		if (windows.length < 2) return;
		const focusedIndex = windows.findIndex(window => window.focused);
		await host.focusWindowById(windows[(focusedIndex + 1) % windows.length]!.id);
	}
}

export class ToggleWindowAlwaysOnTopAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.toggleWindowAlwaysOnTop', title: localizedString('ash', 'workbench.toggleWindowAlwaysOnTop', 'Toggle Window Always on Top'), f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const host = accessor.get(INativeHostService);
		await host.setAlwaysOnTop(!await host.isAlwaysOnTop());
	}
}

export class EnableWindowAlwaysOnTopAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.enableWindowAlwaysOnTop', title: localizedString('ash', 'workbench.enableWindowAlwaysOnTop', 'Turn On Always on Top'), f1: true });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).setAlwaysOnTop(true);
	}
}

export class DisableWindowAlwaysOnTopAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.disableWindowAlwaysOnTop', title: localizedString('ash', 'workbench.disableWindowAlwaysOnTop', 'Turn Off Always on Top'), f1: true });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).setAlwaysOnTop(false);
	}
}

export class ToggleWindowTabsBarAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.toggleWindowTabsBar', title: localizedString('ash', 'workbench.toggleWindowTabsBar', 'Toggle Window Tabs Bar'), f1: isMacintosh });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).performNativeTabAction('toggleBar');
	}
}

export class ShowNextWindowTabAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.showNextWindowTab', title: localizedString('ash', 'workbench.showNextWindowTab', 'Show Next Window Tab'), f1: isMacintosh });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).performNativeTabAction('next');
	}
}

export class NewWindowTabAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.newWindowTab', title: localizedString('ash', 'workbench.newWindowTab', 'New Window Tab'), f1: isMacintosh });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).openNewWindowTab();
	}
}

export class ShowPreviousWindowTabAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.showPreviousWindowTab', title: localizedString('ash', 'workbench.showPreviousWindowTab', 'Show Previous Window Tab'), f1: isMacintosh });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).performNativeTabAction('previous');
	}
}

export class MoveWindowTabToNewWindowAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.moveWindowTabToNewWindow', title: localizedString('ash', 'workbench.moveWindowTabToNewWindow', 'Move Window Tab to New Window'), f1: isMacintosh });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).performNativeTabAction('newWindow');
	}
}

export class MergeWindowTabsAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.mergeWindowTabs', title: localizedString('ash', 'workbench.mergeWindowTabs', 'Merge All Window Tabs'), f1: isMacintosh });
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).performNativeTabAction('merge');
	}
}
