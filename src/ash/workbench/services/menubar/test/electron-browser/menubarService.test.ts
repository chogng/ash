import assert from 'node:assert/strict';
import { test } from 'mocha';
import { SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import type { ISandboxIpcRenderer } from '../../../../../base/parts/sandbox/common/sandboxTypes.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { NATIVE_MENUBAR_SELECT_CHANNEL, type INativeMenubarSelection } from '../../../../../platform/menubar/common/nativeMenubar.js';
import { IMenubarService } from '../../../../../platform/menubar/electron-browser/menubar.js';
import { NativeMenubarMainService, nativeMenubarIpcRoutes, type INativeMenubarMainMenuItem } from '../../../../../platform/menubar/electron-main/menubarMainService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NativeMenubarControl } from '../../../../electron-browser/parts/titlebar/menubarControl.js';
import { TestNotificationService } from '../../../notification/test/common/testNotificationService.js';

test('registered menubar service publishes the controller menu through Main and releases window subscriptions', async () => {
	let template: readonly INativeMenubarMainMenuItem[] | undefined;
	const listeners = new Map<string, (value: unknown) => void>();
	using main = new NativeMenubarMainService({
		applicationName: 'Ash',
		setApplicationMenu: value => {
			template = value;
		},
		setWindowTouchBar() {},
	});
	const window = {
		id: 7,
		isDestroyed: () => false,
		isFocused: () => true,
		on() {},
		removeListener() {},
		webContents: { send: (channel: string, value: unknown) => listeners.get(channel)?.(value) },
	};
	using registration = main.registerWindow(window);
	const routes = nativeMenubarIpcRoutes(main, window);
	const published = new DeferredPromise<void>();
	const bridge: ISandboxIpcRenderer = {
		send() {
			throw new Error('Unexpected IPC send');
		},
		async invoke(channel, value) {
			const route = routes.find(route => route.channel === channel);
			assert.ok(route, 'Only the existing trusted menubar update route is used');
			await route.invoke(route.validate(value));
			await published.complete();
		},
		on(channel, listener) {
			assert.equal(channel, NATIVE_MENUBAR_SELECT_CHANNEL);
			assert.equal(listeners.has(channel), false);
			listeners.set(channel, listener);
			return {
				dispose: () => {
					listeners.delete(channel);
				},
			};
		},
	};
	// The production transport reads Electron's preload boundary at module load.
	const previousBridge = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	Object.defineProperty(globalThis, 'ash', { configurable: true, value: { ipcRenderer: bridge } });
	try {
		await import('../../electron-browser/menubarService.js');
		const descriptors = getSingletonServiceDescriptors().filter(([id]) => id === IMenubarService);
		assert.equal(descriptors.length, 1);
		assert.equal(descriptors[0]![1].supportsDelayedInstantiation, true);
		using services = new InstantiationService(new ServiceCollection(...descriptors));
		using missingServices = new InstantiationService();
		assert.throws(() => missingServices.createInstance(NativeMenubarControl, MenuId.MenubarMainMenu), /menubarService/);
		let runs = 0;
		const action: IAction = {
			id: 'save',
			label: 'Save',
			tooltip: '',
			enabled: true,
			run: async () => {
				runs++;
			},
		};
		services.registerInstance(IMenuService, {
			createMenu: id => ({
				onDidChange: Event.None,
				getActions: () => (id === MenuId.MenubarMainMenu ? [['navigation', [new SubmenuAction('file', 'File', [action])]]] : []),
				dispose() {},
				[Symbol.dispose]() {},
			}),
			getMenuActions: () => [],
		});
		using notifications = new TestNotificationService();
		services.registerInstance(INotificationService, notifications);
		assert.equal(listeners.size, 0, 'The delayed service does not subscribe before a consumer exists');
		using control = services.createInstance(NativeMenubarControl, MenuId.MenubarMainMenu);
		await published.p;
		const item = template?.find(item => item.label === 'File')?.submenu?.find(item => item.label === 'Save');
		assert.ok(item?.click);
		item.click(undefined, window, { altKey: false });
		assert.equal(runs, 1, 'Main selection reaches the controller action');
		const service = services.get(IMenubarService);
		assert.equal(services.get(IMenubarService), service);
		const selections: INativeMenubarSelection[] = [];
		using selection = service.onDidSelect(value => selections.push(value));
		for (const value of [null, { revision: -1, id: 'save' }, { revision: 1.5, id: 'save' }, { revision: 1, id: '' }, { revision: 1, id: 7 }]) {
			window.webContents.send(NATIVE_MENUBAR_SELECT_CHANNEL, value);
		}
		assert.deepEqual(selections, [], 'Malformed IPC selections do not enter the domain');
		await assert.rejects(service.updateMenubar({ revision: -1, menus: [] }), /revision/);
		item.click(undefined, window, { altKey: false });
		assert.equal(runs, 2, 'A rejected update preserves the installed menu');
		control.dispose();
		item.click(undefined, window, { altKey: false });
		assert.equal(runs, 2, 'A disposed controller no longer runs actions');
		selection.dispose();
		services.dispose();
		assert.equal(listeners.size, 0, 'The window container releases the native subscription');
	} finally {
		if (previousBridge) Object.defineProperty(globalThis, 'ash', previousBridge);
		else Reflect.deleteProperty(globalThis, 'ash');
	}
});
