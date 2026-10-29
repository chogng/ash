import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { mock } from 'node:test';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import type { IViewPaneOptions } from '../../../../../../workbench/browser/parts/views/viewPane.js';

test('ViewPane progress follows delay, body visibility, completion and disposal', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(dom);
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { ViewPane } = await import('../../viewPane.js');
		class ProgressPane extends ViewPane {
			constructor() { super(dom.window.document.body, { id: 'progress', title: 'Search' }); }
		}
		using pane = new ProgressPane();
		pane.setVisible(true);
		const indicator = pane.getProgressIndicator();
		assert.equal(pane.getProgressIndicator(), indicator);
		const bar = pane.element.querySelector<HTMLProgressElement>('progress')!;
		const early = indicator.show(true, 150);
		early.done();
		mock.timers.tick(150);
		assert.equal(bar.hidden, true);
		const runner = indicator.show(100, 150);
		runner.worked(25);
		mock.timers.tick(149);
		assert.equal(bar.hidden, true);
		mock.timers.tick(1);
		assert.equal(bar.hidden, false);
		assert.equal(bar.value, 0.25);
		pane.setExpanded(false);
		assert.equal(bar.hidden, true);
		runner.total(50);
		pane.setExpanded(true);
		assert.equal(bar.hidden, false);
		assert.equal(bar.value, 0.5);
		pane.setVisible(false);
		assert.equal(bar.hidden, true);
		pane.setVisible(true);
		assert.equal(bar.hidden, false);
		pane.setTitle('搜索');
		assert.equal(bar.getAttribute('aria-label'), '搜索');
		runner.done();
		assert.equal(bar.hidden, true);
		const delayed = indicator.show(true, 150);
		pane.dispose();
		mock.timers.tick(150);
		delayed.done();
		assert.equal(bar.hidden, true);
		assert.equal(dom.window.document.querySelector('progress'), null);
	} finally {
		mock.timers.reset();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		dom.window.close();
	}
});

test('ViewPane keeps progress until all overlapping promises settle, including failures', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(dom);
	try {
		const { ViewPane } = await import('../../viewPane.js');
		class ProgressPane extends ViewPane {
			constructor() { super(dom.window.document.body, { id: 'progress', title: 'Search' }); }
		}
		using pane = new ProgressPane();
		pane.setVisible(true);
		const indicator = pane.getProgressIndicator();
		const first = new DeferredPromise<void>();
		const second = new DeferredPromise<void>();
		const pendingFirst = indicator.showWhile(first.p);
		const pendingSecond = indicator.showWhile(second.p);
		const bar = pane.element.querySelector<HTMLProgressElement>('progress')!;
		assert.equal(bar.hasAttribute('value'), false);
		assert.equal(bar.hidden, false);
		await second.error(new Error('Search failed'));
		await pendingSecond;
		assert.equal(bar.hidden, false);
		await first.complete();
		await pendingFirst;
		assert.equal(bar.hidden, true);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		dom.window.close();
	}
});

test('ViewPane title chevron tracks collapsed state', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(dom);
	try {
		const { ViewPane } = await import('../../../../../../workbench/browser/parts/views/viewPane.js');
		class TestViewPane extends ViewPane {
			constructor(container: HTMLElement, options: IViewPaneOptions) {
				super(container, options);
			}
		}
		using pane = new TestViewPane(dom.window.document.body, {
			id: 'test.pane',
			title: 'Test Pane',
			collapsed: true,
		});

		const visibility: boolean[] = [];
		using listener = pane.onDidChangeBodyVisibility(value => visibility.push(value));
		assert.equal(pane.isVisible(), false);
		assert.equal(pane.isBodyVisible(), false);
		pane.setVisible(true);
		assert.deepEqual(visibility, []);

		const title = pane.element.querySelector('.ash-pane-view-header-title');
		const button = pane.element.querySelector<HTMLButtonElement>('.ash-pane-view-header-button');
		const content = pane.element.querySelector<HTMLElement>('.ash-pane-view-content');
		assert.equal(title?.textContent, 'Test Pane');
		assert.equal(button?.getAttribute('aria-expanded'), 'false');
		assert.equal(button?.getAttribute('aria-controls'), content?.id);
		assert.equal(button?.classList.contains('expanded'), false);
		assert.equal(pane.element.classList.contains('collapsed'), true);
		assert.equal(content?.hidden, true);
		assert.equal(button?.querySelectorAll('.ash-icon').length, 2);

		button?.click();
		assert.equal(pane.isCollapsed(), false);
		assert.equal(button?.getAttribute('aria-expanded'), 'true');
		assert.equal(button?.classList.contains('expanded'), true);
		assert.equal(pane.element.classList.contains('collapsed'), false);
		assert.equal(content?.hidden, false);

		assert.equal(pane.isBodyVisible(), true);
		assert.deepEqual(visibility, [true]);
		assert.equal(pane.setExpanded(true), false);
		pane.setVisible(false);
		assert.equal(pane.isBodyVisible(), false);
		assert.equal(pane.setExpanded(false), true);
		assert.equal(pane.setExpanded(true), true);
		assert.equal(pane.isBodyVisible(), false);
		pane.setVisible(true);
		assert.deepEqual(visibility, [true, false, true]);

		pane.setTitle('Renamed Pane');
		assert.equal(title?.textContent, 'Renamed Pane');
		assert.equal(button?.querySelectorAll('.ash-icon').length, 2);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		dom.window.close();
	}
});

function installDomGlobals(dom: JSDOM): readonly string[] {
	const globals = {
		window: dom.window,
		document: dom.window.document,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		MouseEvent: dom.window.MouseEvent,
		navigator: dom.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
		});
	}
	return Object.keys(globals);
}

test('PaneView reallocates sibling space when a pane content minimum changes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(dom);
	try {
		const { Pane, PaneView } = await import('../../../../../../base/browser/ui/splitview/paneview.js');
		using view = new PaneView(dom.window.document.body);
		using changes = new Pane(dom.window.document.body, { id: 'changes', title: 'Changes', maximumBodySize: 500 });
		using graph = new Pane(dom.window.document.body, { id: 'graph', title: 'Graph', minimumBodySize: 0 });
		view.addPane(changes, 200);
		view.addPane(graph, 200);
		view.layout(400, 300);
		changes.minimumBodySize = 300;
		assert.equal(view.getPaneSize(changes), 328);
		assert.equal(view.getPaneSize(graph), 72);
		changes.setCollapsed(true);
		changes.minimumBodySize = 200;
		assert.equal(view.getPaneSize(changes), 28);
		changes.setCollapsed(false);
		assert.ok(view.getPaneSize(changes) >= 228);
		assert.throws(() => changes.minimumBodySize = Number.NaN, RangeError);
		assert.throws(() => changes.minimumBodySize = 501, RangeError);
		assert.equal(changes.minimumBodySize, 200);
	} finally {
		for (const name of installedGlobals) { Reflect.deleteProperty(globalThis, name); }
		dom.window.close();
	}
});

test('View welcome content follows context, preserves focus, runs commands and releases its DOM', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(dom);
	try {
		const { ViewPane, ViewWelcomeController } = await import('../../../../../../workbench/browser/parts/views/viewPane.js');
		const { WorkbenchViewRegistry } = await import('../../../../../../workbench/common/views.js');
		const { ContextKeyService, IContextKeyService } = await import('../../../../../../platform/contextkey/browser/contextKeyService.js');
		const { ContextKeyExpr } = await import('../../../../../../platform/contextkey/common/contextkey.js');
		const { InstantiationService } = await import('../../../../../../platform/instantiation/common/instantiationService.js');
		const { registerCodeEditorServices } = await import('../../../../../../editor/test/browser/testCodeEditor.js');
		const { CommandRegistry, ICommandService } = await import('../../../../../../platform/commands/common/commands.js');
		const { CommandService } = await import('../../../../../../workbench/services/commands/common/commandService.js');
		class WelcomePane extends ViewPane {
			public empty = true;
			constructor(container: HTMLElement) { super(container, { id: 'welcome.test', title: 'Welcome' }); }
			public override shouldShowWelcome(): boolean { return this.empty; }
			public changeEmpty(empty: boolean): void { this.empty = empty; this.viewWelcomeState.fire(); }
			public get body(): HTMLElement { return this.contentElement; }
		}
		using services = new InstantiationService();
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		const commands = new CommandRegistry();
		const calls: unknown[][] = [];
		using command = commands.register('welcome.start', (_accessor, ...args) => { calls.push([...args]); });
		using commandService = new CommandService(services, commands);
		services.registerInstance(ICommandService, commandService);
		registerCodeEditorServices(services);
		const registry = new WorkbenchViewRegistry();
		using fallback = registry.registerViewWelcomeContent('welcome.test', { content: 'No provider', when: 'default' });
		using content = registry.registerViewWelcomeContent('welcome.test', {
			content: 'Start source control\n[Start](command:welcome.start?%5B%22folder%22%5D)',
			when: ContextKeyExpr.has('hasFolder'), precondition: ContextKeyExpr.has('ready'),
		});
		using pane = new WelcomePane(dom.window.document.body);
		pane.setVisible(true);
		using controller = services.createInstance(ViewWelcomeController, pane.body, pane, registry);
		controller.update();
		assert.equal(pane.body.querySelector('.ash-view-welcome')?.textContent, 'No provider');
		context.setContext('hasFolder', true);
		const button = pane.body.querySelector<HTMLButtonElement>('.ash-view-welcome button')!;
		assert.equal(button.disabled, true);
		context.setContext('ready', true);
		controller.focus();
		context.setContext('unrelated', true);
		assert.equal(dom.window.document.activeElement, button);
		assert.equal(pane.body.querySelector('.ash-view-welcome button'), button);
		button.click();
		await Promise.resolve();
		assert.deepEqual(calls, [['folder']]);
		context.setContext('ready', false);
		assert.equal(button.disabled, true);
		button.click();
		assert.equal(calls.length, 1);
		context.setContext('ready', true);
		controller.focus();
		pane.changeEmpty(false);
		assert.equal(controller.enabled, false);
		assert.equal(pane.body.classList.contains('welcome'), false);
		assert.equal(dom.window.document.activeElement, pane.element);
		pane.changeEmpty(true);
		assert.equal(controller.enabled, true);
		controller.dispose();
		assert.equal(pane.body.querySelector('.ash-view-welcome'), null);
		context.setContext('hasFolder', false);
		assert.equal(pane.body.classList.contains('welcome'), false);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		dom.window.close();
	}
});
