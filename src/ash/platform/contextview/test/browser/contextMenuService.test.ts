import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../base/browser/dom.js";
import type { IAction } from "../../../../base/common/actions.js";
import { type IMenuActionOptions, IMenuService, MenuId } from "../../../actions/common/actions.js";
import { ContextKeyService, IContextKeyService } from "../../../contextkey/browser/contextKeyService.js";
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ActionRunner } from '../../../../base/common/actions.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { MenuService } from '../../../actions/common/menuService.js';
import { ICommandService } from '../../../commands/common/commands.js';
import { IContextViewService } from '../../browser/contextView.js';
import { BrowserContextViewService } from '../../browser/contextViewService.js';
import { BrowserContextMenuService } from '../../browser/contextMenuService.js';
import { IKeybindingService } from '../../../keybinding/common/keybinding.js';
import { INotificationService } from '../../../notification/common/notification.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { errorHandler } from '../../../../base/common/errors.js';

test("menu delegates prepend explicit actions and use their context-key scope", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: environment.window,
	});
	const { transformContextMenuDelegate } = await import(
		"../../browser/contextMenuService.js"
	);
	const explicit = action("explicit");
	const contributed = action("contributed");
	using globalContext = new ContextKeyService();
	using scopedContext = globalContext.createScoped(h(environment.window.document, "div"));
	let receivedContext: unknown;
	const menuService = {
		getMenuActions(
			_id: MenuId,
			_options?: IMenuActionOptions,
			contextKeyService?: IContextKeyService,
		) {
			receivedContext = contextKeyService;
			return [["navigation", [contributed]]];
		},
	} as unknown as IMenuService;
	const delegate = transformContextMenuDelegate({
		menuId: MenuId.for("test.contextMenu"),
		contextKeyService: scopedContext,
		getAnchor: () => environment.window.document.body,
		getActions: () => [explicit],
	}, menuService, globalContext);

	assert.deepEqual(
		delegate.getActions().filter((item) => item.id !== "ash.actions.separator"),
		[explicit, contributed],
	);
	assert.equal(receivedContext, scopedContext);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

function action(id: string): IAction {
	return {
		id,
		label: id,
		tooltip: id,
		enabled: true,
		run() { },
	};
}

test('browser context menus reject missing services during creation', async () => {
	const { BrowserContextMenuService } = await import('../../browser/contextMenuService.js');
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(BrowserContextMenuService), /menuService/);
});

class BrowserMenuFixture extends Disposable {
	readonly document: Document;
	readonly services: InstantiationService;
	readonly views: BrowserContextViewService;
	readonly menus: BrowserContextMenuService;
	readonly errors: string[] = [];
	readonly origin: HTMLButtonElement;
	readonly outside: HTMLButtonElement;

	constructor() {
		super();
		const browser = new JSDOM('<!doctype html><body><button id="origin">Origin</button><button id="outside">Outside</button></body>');
		this._register(toDisposable(() => browser.window.close()));
		Object.defineProperty(browser.window.Element.prototype, 'scrollTo', { value: () => { } });
		this.document = browser.window.document;
		this.origin = this.document.querySelector<HTMLButtonElement>('#origin')!;
		// jsdom has no layout; focus restoration requires a painted origin.
		Object.defineProperty(this.origin, 'getClientRects', { value: () => [new browser.window.DOMRect(0, 0, 100, 20)] });
		this.outside = this.document.querySelector<HTMLButtonElement>('#outside')!;
		this.services = this._register(new InstantiationService());
		const contextKeys = this._register(new ContextKeyService());
		this.services.registerInstance(IContextKeyService, contextKeys);
		const commands: ICommandService = {
			onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None,
			async executeCommand() { throw new Error('No command in this fixture'); },
		};
		this.services.registerInstance(ICommandService, commands);
		this.services.registerInstance(IMenuService, this.services.createInstance(MenuService));
		this.views = this._register(new BrowserContextViewService(this.document.body));
		this.services.registerInstance(IContextViewService, this.views);
		this.services.registerInstance(IKeybindingService, {
			inChordMode: false, onDidUpdateKeybindings: Event.None,
			getKeybindings: () => [], registerSchemaContribution: () => Disposable.None,
			resolveKeybinding() { throw new Error('No binding in this fixture'); },
			resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
		});
		this.services.registerInstance(INotificationService, { error: (message: string) => this.errors.push(message) } as unknown as INotificationService);
		this.menus = this._register(this.services.createInstance(BrowserContextMenuService));
	}

	show(label: string, token?: CancellationToken, onHide?: (cancelled: boolean) => void): void {
		this.menus.showContextMenu({ getAnchor: () => this.origin, getActions: () => [action(label)], cancellationToken: token, onHide });
	}

	get visibleLabel(): string | undefined {
		return this.document.querySelector('[role="menuitem"]')?.textContent ?? undefined;
	}
}

test('an already canceled browser request leaves the existing menu alone', () => {
	using fixture = new BrowserMenuFixture();
	const hidden: boolean[] = [];
	fixture.show('Existing');
	fixture.show('Canceled', CancellationToken.Cancelled, cancelled => hidden.push(cancelled));
	assert.deepEqual({ label: fixture.visibleLabel, hidden }, { label: 'Existing', hidden: [true] });
});

test('browser cancellation closes once and returns focus to its valid origin', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	const hidden: boolean[] = [];
	fixture.origin.focus();
	fixture.show('Cancel', source.token, cancelled => hidden.push(cancelled));
	source.cancel(); source.cancel();
	assert.deepEqual({ label: fixture.visibleLabel, hidden, focus: fixture.document.activeElement }, { label: undefined, hidden: [true], focus: fixture.origin });
});

test('canceling a replaced browser request preserves the successor', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	const hidden: boolean[] = [];
	fixture.show('Old', source.token, cancelled => hidden.push(cancelled));
	fixture.show('New');
	source.cancel();
	assert.deepEqual({ label: fixture.visibleLabel, hidden }, { label: 'New', hidden: [true] });
});

test('a request opened by a browser hide callback supersedes the interrupted replacement', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	const interrupted: boolean[] = [];
	fixture.show('Old', source.token, () => fixture.show('Reentrant'));
	fixture.show('Interrupted', undefined, cancelled => interrupted.push(cancelled));
	source.cancel();
	assert.deepEqual({ label: fixture.visibleLabel, interrupted }, { label: 'Reentrant', interrupted: [true] });
});

test('browser cancellation during request preparation never replaces an outside dialog', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	const dialog = h(fixture.document, 'input');
	fixture.views.show({ anchor: fixture.origin, content: dialog, presentation: 'dialog' });
	dialog.focus();
	const hidden: boolean[] = [];
	fixture.menus.showContextMenu({
		getAnchor: () => fixture.origin, getActions: () => [action('Canceled')], cancellationToken: source.token,
		getActionsContext: () => source.cancel(), onHide: cancelled => hidden.push(cancelled),
	});
	assert.deepEqual({ connected: dialog.isConnected, focus: fixture.document.activeElement, hidden }, { connected: true, focus: dialog, hidden: [true] });
});

test('browser cancellation after a dialog takes over preserves its focus and content', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	fixture.show('Old', source.token);
	const dialog = h(fixture.document, 'input');
	fixture.views.show({ anchor: fixture.origin, content: dialog, presentation: 'dialog' });
	dialog.focus();
	source.cancel();
	assert.deepEqual({ connected: dialog.isConnected, focus: fixture.document.activeElement }, { connected: true, focus: dialog });
});

test('cancellation from a replaced view callback prevents the prepared browser menu from mounting', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	const hidden: boolean[] = [];
	fixture.views.show({ anchor: fixture.origin, content: h(fixture.document, 'input'), onHide: () => source.cancel() });
	fixture.show('Canceled', source.token, cancelled => hidden.push(cancelled));
	assert.deepEqual({ label: fixture.visibleLabel, hidden }, { label: undefined, hidden: [true] });
});

test('browser cancellation by a show listener closes before any focus is transferred again', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	using listener = fixture.menus.onDidShowContextMenu(() => source.cancel());
	fixture.outside.focus();
	fixture.show('Canceled', source.token);
	assert.deepEqual({ label: fixture.visibleLabel, focus: fixture.document.activeElement }, { label: undefined, focus: fixture.outside });
});

for (const successor of [false, true]) {
	test(`browser cancellation during show layout ${successor ? 'preserves its reentrant successor without an extra show event' : 'leaves no mounted host or show event'}`, () => {
		using fixture = new BrowserMenuFixture();
		using source = new CancellationTokenSource();
		const events: string[] = [];
		using shown = fixture.menus.onDidShowContextMenu(() => events.push('show'));
		using hidden = fixture.menus.onDidHideContextMenu(() => events.push('hide'));
		let measured = false;
		Object.defineProperty(fixture.origin, 'getBoundingClientRect', {
			value: () => {
				if (!measured) { measured = true; source.cancel(); }
				return new fixture.document.defaultView!.DOMRect(0, 0, 100, 20);
			}
		});
		fixture.show('Canceled', source.token, cancelled => {
			events.push(`cancel:${cancelled}`);
			if (successor) { fixture.show('Successor'); }
		});
		const view = fixture.document.querySelector<HTMLElement>('.ash-context-view')!;
		assert.deepEqual({ events, label: fixture.visibleLabel, hostHidden: view.hidden }, {
			events: successor ? ['cancel:true', 'show'] : ['cancel:true'], label: successor ? 'Successor' : undefined, hostHidden: !successor,
		});
		fixture.menus.hideContextMenu();
		assert.deepEqual(events, successor ? ['cancel:true', 'show', 'hide'] : ['cancel:true']);
	});
}

test('layout cancellation finishes mounting before its hide callback mounts a successor', () => {
	using fixture = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	const order: string[] = [];
	Object.defineProperty(fixture.origin, 'getBoundingClientRect', {
		value: () => {
			source.cancel();
			order.push('layout returned');
			return new fixture.document.defaultView!.DOMRect(0, 0, 100, 20);
		}
	});
	fixture.show('Canceled', source.token, () => {
		order.push('hide');
		fixture.menus.showContextMenu({ getAnchor: () => ({ x: 120, y: 200, targetWindow: fixture.document.defaultView! }), getActions: () => [action('Successor')] });
	});
	const view = fixture.document.querySelector<HTMLElement>('.ash-context-view')!;
	assert.deepEqual({ order, label: fixture.visibleLabel, left: view.style.left, top: view.style.top }, { order: ['layout returned', 'hide'], label: 'Successor', left: '120px', top: '200px' });
	fixture.menus.hideContextMenu();
	assert.equal(view.hidden, true);
});

for (const mounting of [false, true]) {
	test(`a browser menu whose view item disposal fails ${mounting ? 'during mount cancellation' : 'during hide'} notifies once and permits a successor`, () => {
		using fixture = new BrowserMenuFixture();
		using source = new CancellationTokenSource();
		const failure = new Error('Menu view item disposal fixture failure');
		const reported: unknown[] = [];
		const previousHandler = errorHandler.getUnexpectedErrorHandler();
		errorHandler.setUnexpectedErrorHandler(error => reported.push(error));
		using restoreHandler = toDisposable(() => errorHandler.setUnexpectedErrorHandler(previousHandler));
		let disposed = 0;
		const hidden: boolean[] = [];
		if (mounting) {
			Object.defineProperty(fixture.origin, 'getBoundingClientRect', {
				value: () => {
					source.cancel();
					return new fixture.document.defaultView!.DOMRect(0, 0, 100, 20);
				}
			});
		}
		fixture.menus.showContextMenu({
			getAnchor: () => fixture.origin, getActions: () => [action('Fault')], cancellationToken: source.token,
			getActionViewItem: selected => new class extends ButtonActionViewItem {
				protected override disposeCore(): void { super.disposeCore(); disposed++; throw failure; }
			}(selected),
			onHide: cancelled => {
				hidden.push(cancelled);
				fixture.menus.showContextMenu({ getAnchor: () => ({ x: 120, y: 200, targetWindow: fixture.document.defaultView! }), getActions: () => [action('Successor')] });
			},
		});
		if (!mounting) { assert.throws(() => fixture.menus.hideContextMenu(), error => error === failure); }
		assert.deepEqual({ disposed, hidden, reported, label: fixture.visibleLabel }, { disposed: 1, hidden: [true], reported: mounting ? [failure] : [], label: 'Successor' });
		fixture.menus.hideContextMenu();
		assert.deepEqual({ disposed, hidden, label: fixture.visibleLabel }, { disposed: 1, hidden: [true], label: undefined });
	});
}

test('browser requests in different documents keep independent cancellation and focus', () => {
	using first = new BrowserMenuFixture();
	using second = new BrowserMenuFixture();
	using source = new CancellationTokenSource();
	first.show('First', source.token);
	second.show('Second');
	const secondFocus = second.document.activeElement;
	source.cancel();
	assert.deepEqual({ first: first.visibleLabel, second: second.visibleLabel, focus: second.document.activeElement }, { first: undefined, second: 'Second', focus: secondFocus });
});

for (const ending of ['cancel', 'replace', 'dispose'] as const) {
	test(`browser ${ending} releases its request cancellation listener`, () => {
		using fixture = new BrowserMenuFixture();
		let listener: (() => unknown) | undefined;
		let released = 0;
		const token: CancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested(callback) { listener = () => callback(undefined); return toDisposable(() => { listener = undefined; released++; }); },
		};
		fixture.show('Old', token);
		if (ending === 'cancel') listener!();
		else if (ending === 'replace') fixture.show('New');
		else fixture.menus.dispose();
		assert.deepEqual({ released, listener }, { released: 1, listener: undefined });
	});
}

for (const disposed of [false, true]) {
	test(`an already started browser action ${disposed ? 'suppresses feedback after disposal' : 'reports a late failure once after presentation cancellation'}`, async () => {
		using fixture = new BrowserMenuFixture();
		using source = new CancellationTokenSource();
		using runner = new ActionRunner();
		const pending = promiseWithResolvers<void>();
		const started = promiseWithResolvers<void>();
		const copy = { ...action('Copy'), run: () => { started.resolve(); return pending.promise; } };
		fixture.menus.showContextMenu({ getAnchor: () => fixture.origin, getActions: () => [copy], cancellationToken: source.token, actionRunner: runner });
		const operation = runner.run(copy);
		await started.promise;
		source.cancel();
		if (disposed) fixture.menus.dispose();
		pending.reject(new Error('Clipboard fixture failure'));
		await operation;
		assert.deepEqual(fixture.errors, disposed ? [] : ['Clipboard fixture failure']);
	});
}

test('a pending shared runner cannot hide a successor when another action starts', async () => {
	using fixture = new BrowserMenuFixture();
	using runner = new ActionRunner();
	const pending = promiseWithResolvers<void>();
	const first = { ...action('First'), run: () => pending.promise };
	fixture.menus.showContextMenu({ getAnchor: () => fixture.origin, getActions: () => [first], actionRunner: runner });
	const operation = runner.run(first);
	fixture.show('Successor');
	await runner.run(action('Other'));
	assert.equal(fixture.visibleLabel, 'Successor');
	pending.resolve();
	await operation;
});

test('browser menus without a token retain window hide and selected action behavior', async () => {
	using fixture = new BrowserMenuFixture();
	using runner = new ActionRunner();
	let runs = 0;
	const selected = { ...action('Selected'), run: () => { runs++; } };
	const hidden: boolean[] = [];
	fixture.menus.showContextMenu({ getAnchor: () => fixture.origin, getActions: () => [selected], actionRunner: runner, onHide: cancelled => hidden.push(cancelled) });
	await runner.run(selected);
	fixture.show('Window close', undefined, cancelled => hidden.push(cancelled));
	fixture.menus.hideContextMenu();
	assert.deepEqual({ runs, hidden, label: fixture.visibleLabel }, { runs: 1, hidden: [false, true], label: undefined });
});
