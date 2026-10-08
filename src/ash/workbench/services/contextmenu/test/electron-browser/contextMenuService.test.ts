import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { NotificationService } from '../../../notification/common/notificationService.js';
import { ElectronContextMenuService } from '../../electron-browser/contextMenuService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Event } from "../../../../../base/common/event.js";
import { DisposableTracker, installDisposableTracker } from '../../../../../base/common/lifecycle.js';
import { AnchorAlignment, AnchorAxisAlignment, ContextViewHideReason, type ContextViewOptions } from "../../../../../base/browser/ui/contextview/contextview.js";
import type { INativeContextMenuApi, INativeContextMenuRequest, INativeContextMenuResult } from "../../../../../base/parts/contextmenu/common/contextmenu.js";
import { IMenuService } from "../../../../../platform/actions/common/actions.js";
import { ContextKeyService, IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { ConfigurationRegistry } from "../../../../../platform/configuration/common/configurationRegistry.js";
import { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import { IKeybindingService } from "../../../../../platform/keybinding/common/keybinding.js";
import { INotificationService } from "../../../../../platform/notification/common/notification.js";

test("Electron context menus run the selected action with its delegate context", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: environment.window,
	});
	const { NativeContextMenuService } = await import(
		"../../electron-browser/contextMenuService.js"
	);
	const api: INativeContextMenuApi = {
		async popup() {
			return { selectedId: "action-1" };
		},
		async close() { },
	};
	using contextKeyService = new ContextKeyService();
	const keybindingService = {
		inChordMode: false,
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	const notificationService = {
		error(message: string) {
			throw new Error(`Unexpected notification: ${message}`);
		},
	} as unknown as INotificationService;
	using services = new InstantiationService();
	services.registerInstance(IMenuService, {} as IMenuService);
	services.registerInstance(IContextKeyService, contextKeyService);
	services.registerInstance(IKeybindingService, keybindingService);
	services.registerInstance(INotificationService, notificationService);
	using service = services.createInstance(NativeContextMenuService, api);
	const actionContext = { resource: "test.txt" };
	let receivedContext: unknown;
	let didCancel: boolean | undefined;
	service.showContextMenu({
		getAnchor: () => ({
			x: 10,
			y: 20,
			targetWindow: environment.window as unknown as Window,
		}),
		getActions: () => [{
			id: "run",
			label: "Run",
			tooltip: "Run",
			enabled: true,
			run(context) {
				receivedContext = context;
			},
		}],
		getActionsContext: () => actionContext,
		onHide: (cancelled) => {
			didCancel = cancelled;
		},
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	assert.equal(receivedContext, actionContext);
	assert.equal(didCancel, false);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("Electron context menus position element and point anchors in CSS pixels", async () => {
	const environment = new JSDOM("<!doctype html><body><button></button></body>");
	Object.defineProperty(globalThis, "window", { configurable: true, value: environment.window });
	const { NativeContextMenuService } = await import("../../electron-browser/contextMenuService.js");
	const requests: INativeContextMenuRequest[] = [];
	const api: INativeContextMenuApi = {
		async popup(request) { requests.push(request); return {}; },
		async close() { },
	};
	using contextKeyService = new ContextKeyService();
	const keybindingService = {
		inChordMode: false,
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	using services = new InstantiationService();
	services.registerInstance(IMenuService, {} as IMenuService);
	services.registerInstance(IContextKeyService, contextKeyService);
	services.registerInstance(IKeybindingService, keybindingService);
	services.registerInstance(INotificationService, { error: (error: unknown) => { throw error; } } as unknown as INotificationService);
	using service = services.createInstance(NativeContextMenuService, api);
	const button = environment.window.document.querySelector("button")!;
	button.getBoundingClientRect = () => ({ left: 100.25, top: 50.5, right: 140.25, bottom: 70.5, width: 40, height: 20, x: 100.25, y: 50.5, toJSON: () => ({}) });
	const action = { id: "open", label: "Open", tooltip: "Open", enabled: true, run() { } };
	service.showContextMenu({
		getAnchor: () => button,
		getActions: () => [action],
		anchorAlignment: AnchorAlignment.Right,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		autoSelectFirstItem: true,
	});
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	button.getBoundingClientRect = () => ({ left: -10, top: -5, right: 30, bottom: 20, width: 40, height: 25, x: -10, y: -5, toJSON: () => ({}) });
	service.showContextMenu({ getAnchor: () => button, getActions: () => [action] });
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	service.showContextMenu({
		getAnchor: () => ({ x: 10.25, y: 20.5, targetWindow: environment.window as unknown as Window }),
		getActions: () => [action],
	});
	await new Promise<void>(resolve => setTimeout(resolve, 0));

	assert.deepEqual(requests.map(({ x, y, elementAnchor, positioningItem }) => ({ x, y, elementAnchor, positioningItem })), [
		{ x: 140.25, y: 50.5, elementAnchor: true, positioningItem: 0 },
		{ x: 30, y: 20, elementAnchor: true, positioningItem: undefined },
		{ x: 10.25, y: 20.5, elementAnchor: undefined, positioningItem: undefined },
	]);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

test("macOS switches context menu implementation when the menu style changes", async () => {
	if (process.platform !== "darwin") return;
	const environment = new JSDOM("<!doctype html><body><button></button></body>");
	Object.defineProperty(globalThis, "window", { configurable: true, value: environment.window });
	Object.defineProperty(globalThis, "Node", { configurable: true, value: environment.window.Node });
	const { ElectronContextMenuService } = await import("../../electron-browser/contextMenuService.js");
	let finishPopup!: (result: INativeContextMenuResult) => void;
	const api: INativeContextMenuApi = {
		popup: () => new Promise(resolve => { finishPopup = resolve; }),
		async close() { },
	};
	let activeView: ContextViewOptions | undefined;
	const contextView = {
		container: environment.window.document.body,
		show(options: ContextViewOptions) {
			activeView = options;
			this.container.append(options.content);
			return true;
		},
		hide() {
			const current = activeView;
			activeView = undefined;
			current?.onHide?.(ContextViewHideReason.Programmatic);
			current?.content.remove();
		},
		layout() { },
	} as IContextViewService;
	using contextKeyService = new ContextKeyService();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: "window.menuStyle", defaultValue: "system", parse: value => value });
	registry.registerConfiguration({ key: "window.titleBarStyle", defaultValue: "custom", parse: value => value });
	using configurationService = new InMemoryConfigurationService(registry);
	const keybindingService = {
		inChordMode: false,
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
		onDidUpdateKeybindings: Event.None,
		resolveKeybinding() { throw new Error("Not used"); },
		resolveUserBinding() { return undefined; },
		lookupKeybindings() { return []; },
		lookupKeybinding() { return undefined; },
	} satisfies IKeybindingService;
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configurationService);
	services.registerInstance(IMenuService, {} as IMenuService);
	services.registerInstance(IContextKeyService, contextKeyService);
	services.registerInstance(IKeybindingService, keybindingService);
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(INotificationService, { error: (error: unknown) => { throw error; } } as unknown as INotificationService);
	using service = services.createInstance(ElectronContextMenuService, api);
	const events: string[] = [];
	using shown = service.onDidShowContextMenu(() => events.push("show"));
	using hidden = service.onDidHideContextMenu(() => events.push("hide"));
	const action = { id: "open", label: "Open", tooltip: "Open", enabled: true, run() { } };
	service.showContextMenu({
		getAnchor: () => ({ x: 10, y: 20, targetWindow: environment.window as unknown as Window }),
		getActions: () => [action],
	});
	finishPopup({});
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	await configurationService.updateValue("window.menuStyle", "custom");
	service.showContextMenu({
		getAnchor: () => environment.window.document.querySelector("button")!,
		getActions: () => [action],
		anchorAlignment: AnchorAlignment.Left,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
	});
	assert.deepEqual(events, ["show", "hide", "show"]);
	service.hideContextMenu();
	assert.deepEqual(events, ["show", "hide", "show", "hide"]);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "Node");
});

test('Electron context menus reject missing window services without retaining resources', async () => {
	const { ElectronContextMenuService } = await import('../../electron-browser/contextMenuService.js');
	const api: INativeContextMenuApi = {
		async popup() { return {}; },
		async close() { },
	};
	using configuration = new InMemoryConfigurationService(new ConfigurationRegistry());
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	assert.throws(() => services.createInstance(ElectronContextMenuService, api), /configurationService/);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IMenuService, {} as IMenuService);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IKeybindingService, {} as IKeybindingService);
	assert.throws(() => services.createInstance(ElectronContextMenuService, api), /contextViewService/);
	tracker.assertNoLeaks();
});

class SystemMenuFixture extends Disposable {
	readonly document: Document;
	readonly menus: ElectronContextMenuService;
	readonly notifications: NotificationService;
	readonly popups: { request: INativeContextMenuRequest; finish(result: INativeContextMenuResult): void; }[] = [];
	readonly hidden: { label: string; cancelled: boolean; }[] = [];
	readonly events: string[] = [];
	readonly closeAcknowledged = promiseWithResolvers<void>();
	closeRequests = 0;

	constructor(options: { delayClose?: boolean; close?: () => Promise<void>; } = {}) {
		super();
		const browser = new JSDOM('<!doctype html><body><button id="origin">Origin</button></body>');
		this._register(toDisposable(() => browser.window.close()));
		this.document = browser.window.document;
		const services = this._register(new InstantiationService());
		this.notifications = this._register(new NotificationService());
		services.registerInstance(INotificationService, this.notifications);
		const contextKeys = this._register(new ContextKeyService());
		services.registerInstance(IContextKeyService, contextKeys);
		const contextViews = this._register(new BrowserContextViewService(this.document.body));
		services.registerInstance(IContextViewService, contextViews);
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration({ key: 'window.menuStyle', defaultValue: 'system', parse: value => value });
		registry.registerConfiguration({ key: 'window.titleBarStyle', defaultValue: 'system', parse: value => value });
		const configuration = this._register(new InMemoryConfigurationService(registry));
		services.registerInstance(IConfigurationService, configuration);
		const commands = this._register(new CommandService(services));
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IMenuService, services.createInstance(MenuService));
		services.registerInstance(IKeybindingService, {
			inChordMode: false, onDidUpdateKeybindings: Event.None,
			getKeybindings: () => [], registerSchemaContribution: () => Disposable.None,
			resolveKeybinding() { throw new Error('No binding in this fixture'); },
			resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
		});
		const popupApi: INativeContextMenuApi = {
			popup: request => {
				const pending = promiseWithResolvers<INativeContextMenuResult>();
				this.popups.push({ request, finish: pending.resolve });
				return pending.promise;
			},
			close: () => { this.closeRequests++; return options.close?.() ?? (options.delayClose ? this.closeAcknowledged.promise : Promise.resolve()); },
		};
		this.menus = this._register(services.createInstance(ElectronContextMenuService, popupApi));
		this._register(this.menus.onDidShowContextMenu(() => this.events.push('show')));
		this._register(this.menus.onDidHideContextMenu(() => this.events.push('hide')));
	}

	show(label: string, token?: CancellationToken, selected: IAction = menuAction(label), onHide?: () => void): Promise<boolean> {
		const ended = promiseWithResolvers<boolean>();
		this.menus.showContextMenu({
			getAnchor: () => ({ x: 10, y: 20, targetWindow: this.document.defaultView! }),
			getActions: () => [selected], cancellationToken: token,
			onHide: cancelled => { this.hidden.push({ label, cancelled }); ended.resolve(cancelled); onHide?.(); },
		});
		return ended.promise;
	}

	showBrowser(label: string): void {
		this.menus.showContextMenu({
			getAnchor: () => this.document.querySelector<HTMLButtonElement>('#origin')!,
			getActions: () => [menuAction(label)],
			anchorAlignment: AnchorAlignment.Left, anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			onHide: cancelled => this.hidden.push({ label, cancelled }),
		});
	}
}

function menuAction(label: string): IAction {
	return { id: label, label, tooltip: '', enabled: true, run() { } };
}

test('already canceled system requests do not display or disturb the current popup', async () => {
	using fixture = new SystemMenuFixture();
	const existing = fixture.show('Existing');
	assert.equal(await fixture.show('Canceled', CancellationToken.Cancelled), true);
	assert.deepEqual({ popups: fixture.popups.length, closes: fixture.closeRequests, hidden: fixture.hidden }, { popups: 1, closes: 0, hidden: [{ label: 'Canceled', cancelled: true }] });
	fixture.popups[0].finish({});
	await existing;
});

test('canceling a system request frees its slot after actual close and ignores the old selected result', async () => {
	using fixture = new SystemMenuFixture({ delayClose: true });
	using source = new CancellationTokenSource();
	let runs = 0;
	const selected = { ...menuAction('Selected'), run: () => { runs++; } };
	const old = fixture.show('Old', source.token, selected);
	source.cancel();
	assert.equal(await fixture.show('Still closing'), true);
	assert.deepEqual({ closes: fixture.closeRequests, popups: fixture.popups.length }, { closes: 1, popups: 1 });
	fixture.closeAcknowledged.resolve();
	assert.equal(await old, true);
	const next = fixture.show('Next', undefined, selected);
	assert.equal(fixture.popups.length, 2);
	fixture.popups[0].finish({ selectedId: 'action-1' });
	fixture.popups[1].finish({ selectedId: 'action-1' });
	assert.equal(await next, false);
	assert.deepEqual({ runs, hidden: fixture.hidden, events: fixture.events }, {
		runs: 1, hidden: [{ label: 'Still closing', cancelled: true }, { label: 'Old', cancelled: true }, { label: 'Next', cancelled: false }], events: ['show', 'hide', 'show', 'hide'],
	});
});

test('canceling a system menu preserves its replacement before the popup result returns', async () => {
	using fixture = new SystemMenuFixture({ delayClose: true });
	using source = new CancellationTokenSource();
	let runs = 0;
	const old = fixture.show('Old', source.token, { ...menuAction('Old'), run: () => { runs++; } });
	fixture.showBrowser('Replacement');
	source.cancel();
	fixture.closeAcknowledged.resolve();
	await old;
	fixture.popups[0].finish({ selectedId: 'action-1' });
	const view = fixture.document.querySelector<HTMLElement>('.ash-context-view')!;
	assert.deepEqual({ visible: !view.hidden, label: fixture.document.querySelector('[role="menuitem"]')?.textContent, hidden: fixture.hidden, events: fixture.events, runs }, {
		visible: true, label: 'Replacement', hidden: [{ label: 'Old', cancelled: true }], events: ['show'], runs: 0,
	});
	fixture.menus.hideContextMenu();
	assert.equal(view.hidden, true);
});

test('a system request canceled by the show event never executes a late selection', async () => {
	using fixture = new SystemMenuFixture();
	using source = new CancellationTokenSource();
	let runs = 0;
	using shown = fixture.menus.onDidShowContextMenu(() => source.cancel());
	const ended = fixture.show('Old', source.token, { ...menuAction('Old'), run: () => { runs++; } });
	await ended;
	fixture.popups[0].finish({ selectedId: 'action-1' });
	assert.deepEqual({ runs, closes: fixture.closeRequests, hidden: fixture.hidden }, { runs: 0, closes: 1, hidden: [{ label: 'Old', cancelled: true }] });
});

test('a failed system close keeps the real slot occupied but allows a later close to retry', async () => {
	const failure = new Error('Host close fixture failure');
	const logged = promiseWithResolvers<void>();
	const errors: unknown[][] = [];
	const previousError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); logged.resolve(); };
	using restore = toDisposable(() => { console.error = previousError; });
	let attempts = 0;
	using fixture = new SystemMenuFixture({ close: () => ++attempts === 1 ? Promise.reject(failure) : Promise.resolve() });
	using source = new CancellationTokenSource();
	const old = fixture.show('Old', source.token);
	source.cancel();
	await logged.promise;
	assert.equal(await fixture.show('Still occupied'), true);
	fixture.menus.hideContextMenu();
	await old;
	const next = fixture.show('Next');
	assert.deepEqual({ closes: fixture.closeRequests, popups: fixture.popups.length, errors: errors.map(args => args[1]) }, { closes: 2, popups: 2, errors: [failure] });
	fixture.popups[1].finish({});
	await next;
});

test('a system hide callback can open a successor without losing visibility or its popup slot', async () => {
	using fixture = new SystemMenuFixture();
	using source = new CancellationTokenSource();
	let next!: Promise<boolean>;
	const old = fixture.show('Old', source.token, menuAction('Old'), () => { next = fixture.show('Reentrant'); });
	fixture.popups[0].finish({});
	await old;
	source.cancel();
	assert.deepEqual({ popups: fixture.popups.length, closes: fixture.closeRequests, events: fixture.events }, { popups: 2, closes: 0, events: ['show'] });
	fixture.popups[1].finish({});
	await next;
	assert.deepEqual(fixture.events, ['show', 'hide']);
});

test('a browser hide callback keeps its reentrant successor visible in the Electron service', () => {
	using fixture = new SystemMenuFixture();
	using source = new CancellationTokenSource();
	fixture.menus.showContextMenu({
		getAnchor: () => fixture.document.querySelector<HTMLButtonElement>('#origin')!,
		getActions: () => [menuAction('Old')], cancellationToken: source.token,
		anchorAlignment: AnchorAlignment.Left, anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		onHide: () => fixture.showBrowser('Reentrant'),
	});
	source.cancel();
	assert.deepEqual({ label: fixture.document.querySelector('[role="menuitem"]')?.textContent, events: fixture.events }, { label: 'Reentrant', events: ['show'] });
	fixture.menus.hideContextMenu();
	assert.deepEqual(fixture.events, ['show', 'hide']);
});

for (const disposed of [false, true]) {
	test(`a started system action ${disposed ? 'suppresses its failure after window disposal' : 'reports a failure once despite later presentation cancellation'}`, async () => {
		using fixture = new SystemMenuFixture();
		using source = new CancellationTokenSource();
		const pending = promiseWithResolvers<void>();
		const started = promiseWithResolvers<void>();
		const reported = promiseWithResolvers<void>();
		using listener = fixture.notifications.onDidAdd(() => reported.resolve());
		const selected = { ...menuAction('Selected'), run: () => { started.resolve(); return pending.promise; } };
		fixture.show('Old', source.token, selected);
		fixture.popups[0].finish({ selectedId: 'action-1' });
		await started.promise;
		source.cancel();
		if (disposed) fixture.menus.dispose();
		pending.reject(new Error('Clipboard fixture failure'));
		if (!disposed) await reported.promise;
		else await pending.promise.catch(() => { });
		assert.deepEqual(fixture.notifications.getNotifications().map(item => item.message), disposed ? [] : ['Clipboard fixture failure']);
	});
}

test('a synchronous system action failure is reported exactly once', async () => {
	using fixture = new SystemMenuFixture();
	const ended = fixture.show('Failure', undefined, { ...menuAction('Failure'), run() { throw new Error('Synchronous fixture failure'); } });
	fixture.popups[0].finish({ selectedId: 'action-1' });
	await ended;
	assert.deepEqual(fixture.notifications.getNotifications().map(item => item.message), ['Synchronous fixture failure']);
});

for (const ending of ['cancel', 'selected', 'dispose'] as const) {
	test(`system ${ending} releases the request token listener`, async () => {
		using fixture = new SystemMenuFixture();
		using source = new CancellationTokenSource();
		let released = 0;
		const token: CancellationToken = {
			get isCancellationRequested() { return source.token.isCancellationRequested; },
			onCancellationRequested(listener) {
				const subscription = source.token.onCancellationRequested(listener);
				return toDisposable(() => { subscription.dispose(); released++; });
			},
		};
		const ended = fixture.show('Old', token);
		if (ending === 'cancel') source.cancel();
		else if (ending === 'selected') fixture.popups[0].finish({ selectedId: 'action-1' });
		else fixture.menus.dispose();
		await ended;
		assert.equal(released, 1);
	});
}

test('system cancellation does not close a different window menu or steal its focus', async () => {
	using first = new SystemMenuFixture();
	using second = new SystemMenuFixture();
	using source = new CancellationTokenSource();
	const old = first.show('First', source.token);
	second.showBrowser('Second');
	const focus = second.document.activeElement;
	source.cancel();
	await old;
	assert.deepEqual({ label: second.document.querySelector('[role="menuitem"]')?.textContent, focus: second.document.activeElement, closes: second.closeRequests }, { label: 'Second', focus, closes: 0 });
});
