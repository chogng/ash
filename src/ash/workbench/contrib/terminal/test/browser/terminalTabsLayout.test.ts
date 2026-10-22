import { IEnvironmentVariableService } from '../../common/environmentVariable.js';
import { EnvironmentVariableService } from '../../common/environmentVariableService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { IHoverService, HoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';
import { mock } from 'node:test';
import { TerminalResizeDebouncer } from '../../browser/terminalResizeDebouncer.js';
import type { XtermTerminal } from '../../browser/xterm/xtermTerminal.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { ITerminalService, ITerminalGroupService, type ITerminalInstance } from '../../browser/terminal.js';
import { TerminalGroupService } from '../../browser/terminalGroupService.js';
import { TerminalGroup } from '../../browser/terminalGroup.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchLayoutService, Position, positionToString } from '../../../../services/layout/browser/layoutService.js';

import assert from "node:assert/strict";
import { test, suite, suiteTeardown } from "mocha";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../base/test/common/utils.js";
import { JSDOM } from "jsdom";
import { h } from "../../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
setIconResolver(browserEnvironment.window.document, icon => getIconDefinition(icon));
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	MouseEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { TerminalTabbedView } = await import("../../../../../workbench/contrib/terminal/browser/terminalTabbedView.js");

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"]) {
		Reflect.deleteProperty(globalThis, name);
	}
});

suite('Terminal Panel orientation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('four Panel positions preserve three pane proportions, screen identity, selection and hidden layout', () => {
		const document = browserEnvironment.window.document;
		const host = document.createElement('main');
		const reopened = document.createElement('main');
		const outside = document.createElement('button');
		document.body.append(host, reopened, outside);
		using positionChanged = new Emitter<string>();
		let position = Position.BOTTOM;
		const inputs: HTMLInputElement[] = [];
		const instances = ['first', 'second', 'third'].map((id, index) => {
			const element = document.createElement('div');
			const input = document.createElement('input');
			input.value = `pending ${id}`;
			element.append(input);
			inputs.push(input);
			return {
				id, instanceId: index + 1, title: id, processId: index + 100,
				xterm: { element, fit() { }, setVisible() { }, focus: () => input.focus() },
				attachToElement: (pane: HTMLElement) => pane.append(element),
				detachFromElement: () => element.remove(),
			} as unknown as ITerminalInstance;
		});
		let active: ITerminalInstance | undefined = instances[1];
		using services = new InstantiationService();
		services.registerInstance(ITerminalService, {
			instances, get activeInstance() { return active; },
			setActiveInstance: (instance: ITerminalInstance | undefined) => { active = instance; },
		} as unknown as ITerminalService);
		services.registerInstance(IWorkbenchLayoutService, {
			getPanelPosition: () => position, onDidChangePanelPosition: positionChanged.event,
		} as IWorkbenchLayoutService);
		using group = services.createInstance(TerminalGroup, instances[0]!);
		group.addInstance(instances[1]!);
		group.addInstance(instances[2]!);
		group.layout(1_200, 900);
		group.attachToElement(host);
		group.setVisible(true);
		group.resizePanes([2, 3, 5]);
		const screens = instances.map(instance => instance.xterm!.element);
		const assertState = (orientation: string): void => {
			assert.equal(host.querySelector('.ash-terminal-group')?.classList.contains(`ash-split-view-${orientation}`), true);
			assert.deepEqual(group.terminalInstances, instances);
			assert.equal(group.activeInstance, instances[1]);
			assert.deepEqual(instances.map(instance => instance.xterm!.element), screens);
			assert.deepEqual(inputs.map(input => input.value), ['pending first', 'pending second', 'pending third']);
			assert.deepEqual(group.getLayoutInfo(true).terminals.map(pane => pane.relativeSize), [0.2, 0.3, 0.5]);
		};
		try {
			inputs[1]!.focus();
			group.layout(1_200, 180);
			position = Position.LEFT;
			positionChanged.fire('left');
			// Applying the old bottom height to the new axis would clamp all three
			// panes to their minimum and erase the unequal proportions.
			assert.deepEqual(group.getLayoutInfo(true).terminals.map(pane => pane.relativeSize), [0.2, 0.3, 0.5]);
			group.layout(400, 900);
			assertState('vertical');
			assert.equal(document.activeElement, inputs[1]);
			for (const [next, orientation] of [[Position.LEFT, 'vertical'], [Position.RIGHT, 'vertical'], [Position.TOP, 'horizontal'], [Position.BOTTOM, 'horizontal']] as const) {
				position = next;
				// Part layout can precede the host's position notification.
				group.layout(orientation === 'vertical' ? 400 : 1_200, 900);
				positionChanged.fire(positionToString(next));
				group.layout(1_200, 900);
				assertState(orientation);
				assert.equal(document.activeElement, inputs[1]);
			}
			group.setVisible(false);
			outside.focus();
			group.layout(0, 0);
			position = Position.RIGHT;
			positionChanged.fire('right');
			assertState('horizontal');
			assert.equal(document.activeElement, outside);
			assert.equal(host.querySelector<HTMLElement>('.ash-terminal-group')!.hidden, true);
			group.layout(600, 1_200);
			assertState('vertical');
			group.setVisible(true);
			group.attachToElement(reopened);
			assert.equal(reopened.querySelector('.ash-terminal-group')?.classList.contains('ash-split-view-vertical'), true);
			assert.deepEqual(group.getLayoutInfo(true).terminals.map(pane => pane.relativeSize), [0.2, 0.3, 0.5]);
			assert.equal(document.activeElement, outside);
			const sash = reopened.querySelector<HTMLElement>('.ash-sash')!;
			sash.focus();
			position = Position.TOP;
			positionChanged.fire('top');
			group.layout(1_200, 600);
			assert.equal(document.activeElement, reopened.querySelector('.ash-sash'));
		} finally {
			group.dispose();
			host.remove();
			reopened.remove();
			outside.remove();
		}
	});
});

test("Terminal instance list sash resizes the right column within its bounds", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	const parent = h(dom.window.document, 'main');
	using changed = new Emitter<void>();
	using created = new Emitter<ITerminalInstance>();
	using disposed = new Emitter<ITerminalInstance>();
	const createInstance = (id: string): ITerminalInstance => ({
		...Disposable.None, id, instanceId: id === 'one' ? 1 : id === 'two' ? 2 : 3, dirId: 'folder', processId: 1, initialCwd: '/folder', title: id,
		profile: { profileId: 'shell', title: 'Shell', isDefault: true }, state: 'running', exitCode: undefined,
		onDidWriteData: Event.None, onDidChangeCommandStatus: Event.None, onDidExit: Event.None, onDidChangeState: Event.None,
		xterm: undefined, xtermReadyPromise: Promise.resolve(undefined), getContribution: () => null, start() { }, attachToElement() { }, detachFromElement() { }, async setAutoReplies() { }, async sendSignal() { }, async sendText() { }, async sendPath() { throw new Error('Layout fixture does not insert file paths'); }, processBinary: async () => { }, resize() { }, clearBuffer() { }, reuseTerminal: async () => { throw new Error('Layout fixture does not replace processes'); }, close: async () => { }, refreshProperty: async () => { throw new Error("No OS process in layout fixture"); }, serializeState: async () => { throw new Error("No process checkpoint in layout fixture"); },
	});
	const instances = [createInstance('one'), createInstance('two')];
	const terminals: ITerminalService = {
		...Disposable.None, instances, activeInstance: instances[0], onDidCreateInstance: created.event,
		onDidDisposeInstance: disposed.event, onDidChangeInstances: changed.event, onDidChangeActiveInstance: Event.None,
		createTerminal: async () => { throw new Error('Unexpected creation'); },
		relaunchTerminal: async () => { }, setActiveInstance() { }, moveTerminal() { }, whenConnected: Promise.resolve(), importTerminalState: async () => { throw new Error('Transfer is not used in this fixture'); }, confirmTerminalClose: async () => true, safeDisposeTerminal: async () => { }, closeTerminal: async () => { },
	};
	using services = new InstantiationService();
	using context = new ContextKeyService();
	using commands = new CommandService(services);
	services.registerInstance(ITerminalService, terminals);
	services.registerSingleton(IWorkspaceContextService, () => new TestWorkspaceService({ id: 'terminal-tabs-test', folders: [] }));
	services.registerSingleton(IEnvironmentVariableService, () => services.createInstance(EnvironmentVariableService));
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, new MenuService(commands, context));
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { },
	});
	registerTestComponentServices(services, dom.window.document);
	using hoverConfiguration = new TestConfigurationService();
	services.registerInstance(IConfigurationService, hoverConfiguration);
	using hoverContext = new BrowserContextViewService(dom.window.document.body);
	using hoverService = new HoverService(hoverConfiguration, hoverContext, services.get(IContextMenuService));
	services.registerInstance(IHoverService, hoverService);
	services.registerInstance(IViewsService, { openView: async () => null } as unknown as IViewsService);
	using positionChanged = new Emitter<string>();
	let panelPosition = Position.BOTTOM;
	services.registerInstance(IWorkbenchLayoutService, {
		getPanelPosition: () => panelPosition, onDidChangePanelPosition: positionChanged.event,
	} as unknown as IWorkbenchLayoutService);
	using groups = services.createInstance(TerminalGroupService);
	services.registerInstance(ITerminalGroupService, groups);
	using layout = services.createInstance(TerminalTabbedView, parent);
	const tabs = layout.element.querySelector<HTMLElement>('.ash-terminal-tabs')!;
	dom.window.document.body.append(layout.element);
	layout.layout(1_000, 200);
	const panes = layout.element.querySelectorAll<HTMLElement>(":scope > .ash-split-view-pane");
	const sash = layout.element.querySelector<HTMLElement>(":scope > .ash-sash");
	assert.equal(panes.length, 2);
	assert.ok(sash);
	assert.equal(panes[0]?.style.width, "880px");
	assert.equal(panes[1]?.style.width, "120px");
	assert.equal(sash.getAttribute("aria-label"), "Resize terminal instance list");
	instances.reverse();
	changed.fire();
	assert.deepEqual([...tabs.querySelectorAll('[role="tab"]')].map(row => row.id), ['two-tab', 'one-tab']);
	instances.reverse();
	changed.fire();
	for (const [width, height] of [[0, 0], [1_000, 0], [0, 200]]) {
		layout.layout(width!, height!);
		layout.layout(1_000, 200);
		assert.equal(panes[1]?.style.width, "120px");
		assert.equal(tabs.classList.contains("ash-terminal-tabs-narrow"), false);
		assert.equal(services.get(IStorageService).getNumber('tabs-list-width-horizontal', StorageScope.WORKSPACE), 120);
	}

	sash.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 880, bubbles: true }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 950, bubbles: true }));
	assert.equal(panes[1]?.style.width, "46px");
	assert.equal(tabs.classList.contains("ash-terminal-tabs-narrow"), true);
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientX: 950, bubbles: true }));

	sash.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 954, bubbles: true }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 930, bubbles: true }));
	assert.equal(panes[1]?.style.width, "80px");
	assert.equal(tabs.classList.contains("ash-terminal-tabs-narrow"), false);
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientX: 930, bubbles: true }));

	for (let index = 0; index < 50; index += 1) {
		sash.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
	}
	assert.equal(panes[1]?.style.width, "500px");

	const third = createInstance('three');
	instances.push(third);
	created.fire(third);
	groups.joinInstances([instances[0]!, third]);
	assert.deepEqual([...tabs.querySelectorAll('[role="tab"]')].map(row => row.id), ['one-tab', 'three-tab', 'two-tab']);
	groups.joinInstances([instances[0]!, instances[1]!]);
	const group = groups.activeGroup!;
	group.attachToElement(layout.terminalContainer);
	group.setVisible(true);
	group.layout(500, 800);
	group.resizePanes([2, 1, 1]);
	const paneSizes = () => [...layout.element.querySelectorAll<HTMLElement>('.ash-terminal-group > .ash-split-view-pane')].map(pane => panelPosition === Position.BOTTOM || panelPosition === Position.TOP ? Number.parseFloat(pane.style.width) : Number.parseFloat(pane.style.height));
	const relativeSizes = group.getLayoutInfo(true).terminals.map(terminal => terminal.relativeSize);
	for (const position of [Position.LEFT, Position.RIGHT, Position.TOP, Position.BOTTOM]) {
		panelPosition = position;
		positionChanged.fire(positionToString(position));
		// Enough height permits unequal vertical panes and demonstrates the axis follows position.
		group.layout(500, 800);
		assert.equal(layout.element.querySelector('.ash-terminal-group')?.classList.contains('ash-split-view-horizontal'), position === Position.TOP || position === Position.BOTTOM);
		const actualSizes = group.getLayoutInfo(true).terminals.map(terminal => terminal.relativeSize);
		assert.ok(actualSizes.every((size, index) => Math.abs(size - relativeSizes[index]!) < 0.01));
		assert.ok(paneSizes().every(size => size > 0));
		group.layout(600, 900);
		assert.ok(group.getLayoutInfo(true).terminals.every((terminal, index) => Math.abs(terminal.relativeSize - relativeSizes[index]!) < 0.01));
		group.layout(0, 0);
		assert.ok(group.getLayoutInfo(true).terminals.every((terminal, index) => Math.abs(terminal.relativeSize - relativeSizes[index]!) < 0.01));
		group.layout(100, 100);
		group.layout(500, 800);
		const rendered = paneSizes();
		const renderedTotal = rendered.reduce((sum, size) => sum + size, 0);
		assert.ok(rendered.every((size, index) => Math.abs(size / renderedTotal - relativeSizes[index]!) < 0.01));
	}
	layout.layout(1_000, 200);
	assert.deepEqual([...tabs.querySelectorAll('.ash-terminal-group-branch')].map(branch => branch.textContent), ['┌', '├', '└']);
	assert.equal(tabs.querySelector('[id="three-tab"]')?.getAttribute('aria-description'), 'Split 2 of 3 in terminal group 1');
	groups.unsplitInstance(third);
	instances.pop();
	disposed.fire(third);
	groups.unsplitInstance(instances[1]!);
	assert.equal([...tabs.querySelectorAll<HTMLElement>('.ash-terminal-group-branch')].every(branch => branch.hidden), true);

	const second = instances.pop()!;
	disposed.fire(second);
	changed.fire();
	assert.equal(panes[1]?.hidden, true);
	assert.equal(panes[0]?.style.width, "1000px");
	const hiddenSash = layout.element.querySelector<HTMLElement>(":scope > .ash-sash");
	assert.ok(hiddenSash);
	assert.equal(hiddenSash.classList.contains("ash-sash-disabled"), true);
	assert.equal(hiddenSash.getAttribute("aria-disabled"), "true");

	instances.push(second);
	created.fire(second);
	changed.fire();
	assert.equal(panes[1]?.hidden, false);
	assert.equal(panes[1]?.style.width, "500px");
	assert.equal(layout.element.querySelector(":scope > .ash-sash"), hiddenSash);
	assert.equal(layout.element.querySelector(":scope > .ash-sash")?.getAttribute("aria-label"), "Resize terminal instance list");
	assert.equal(services.get(IStorageService).getNumber('tabs-list-width-horizontal', StorageScope.WORKSPACE), 500);
	using recreated = services.createInstance(TerminalTabbedView, parent);
	recreated.layout(1_000, 200);
	assert.equal(recreated.element.querySelectorAll<HTMLElement>(':scope > .ash-split-view-pane')[1]?.style.width, '500px');
	for (const invalidWidth of [-1, 501, Number.NaN]) {
		services.get(IStorageService).store('tabs-list-width-horizontal', invalidWidth, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using invalid = services.createInstance(TerminalTabbedView, parent);
		invalid.layout(1_000, 200);
		assert.equal(invalid.element.querySelectorAll<HTMLElement>(':scope > .ash-split-view-pane')[1]?.style.width, '120px');
	}

	dom.window.close();
});


suite('Terminal screen resize lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('Terminal screen resize coalesces columns, applies rows immediately and flushes explicitly', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const calls: unknown[] = [];
			const screen = { isDisposed: false, raw: { buffer: { normal: { length: 400 } } } } as unknown as XtermTerminal;
			using resize = new TerminalResizeDebouncer(() => true, () => screen,
				(cols, rows) => calls.push(['both', cols, rows]), cols => calls.push(['x', cols]), rows => calls.push(['y', rows]));
			await resize.resize(90, 30, false);
			await resize.resize(100, 40, false);
			assert.deepEqual(calls, [['y', 30], ['y', 40]]);
			mock.timers.tick(99);
			assert.deepEqual(calls, [['y', 30], ['y', 40]]);
			mock.timers.tick(1);
			assert.deepEqual(calls, [['y', 30], ['y', 40], ['x', 100]]);
			await resize.resize(110, 45, false);
			resize.flush();
			assert.deepEqual(calls.slice(-2), [['y', 45], ['x', 110]]);
			await resize.resize(120, 50, true);
			mock.timers.tick(200);
			assert.deepEqual(calls.at(-1), ['both', 120, 50]);
		} finally { mock.timers.reset(); }
	});

	test('Terminal screen resize keeps the latest hidden dimensions and releases idle work', async () => {
		let idle: (() => void) | undefined;
		let canceled = 0;
		const targetWindow = {
			requestIdleCallback: (work: () => void) => { idle = work; return 1; },
			cancelIdleCallback: () => { idle = undefined; canceled++; },
		};
		const screen = {
			isDisposed: false, raw: { buffer: { normal: { length: 400 } } },
			element: { ownerDocument: { defaultView: targetWindow } },
		} as unknown as XtermTerminal;
		const calls: unknown[] = [];
		using resize = new TerminalResizeDebouncer(() => false, () => screen,
			(cols, rows) => calls.push([cols, rows]), () => assert.fail('Unexpected horizontal-only resize'), () => assert.fail('Unexpected vertical-only resize'));
		await resize.resize(90, 30, false);
		await resize.resize(100, 40, false);
		assert.deepEqual(calls, []);
		assert.ok(idle);
		idle();
		assert.deepEqual(calls, [[100, 40]]);
		await resize.resize(110, 50, false);
		resize.dispose();
		assert.equal(idle, undefined);
		assert.equal(canceled, 2);
		resize.flush();
		assert.deepEqual(calls, [[100, 40]]);
	});

	test('Terminal screen resize cancels pending work after disposal and tolerates disposal in a callback', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const calls: unknown[] = [];
			const screen = { isDisposed: false, raw: { buffer: { normal: { length: 400 } } } } as unknown as XtermTerminal;
			const resize = new TerminalResizeDebouncer(() => true, () => screen,
				() => assert.fail('Unexpected immediate resize'), cols => calls.push(cols), () => { });
			await resize.resize(90, 30, false);
			resize.dispose();
			mock.timers.tick(200);
			assert.deepEqual(calls, []);
			using reentrant = new TerminalResizeDebouncer(() => true, () => screen, () => { }, () => assert.fail('Disposed owner resized'), () => reentrant.dispose());
			await reentrant.resize(100, 40, false);
			mock.timers.tick(200);
		} finally { mock.timers.reset(); }
	});

});
