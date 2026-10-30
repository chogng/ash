import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../base/common/event.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from '../../../../base/common/layout.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import type { IContextMenuService } from '../../../contextview/browser/contextView.js';
import { HoverConfiguration } from '../../common/hoverService.js';
import { h } from '../../../../base/browser/dom.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { CommandsRegistry } from '../../../commands/common/commands.js';
import { ILayoutService } from '../../../layout/browser/layoutService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { AccessibleViewRegistry } from '../../../accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewProviderId, AccessibleViewType } from '../../../accessibility/browser/accessibleView.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getWindows } from '../../../../base/browser/window.js';

ensureNoDisposablesAreLeakedInTestSuite();

const environment = new JSDOM("<!doctype html><html><body><main><button id='first'>First</button><button id='second'>Second</button></main></body></html>");
Object.defineProperties(globalThis, {
	window: { configurable: true, value: environment.window },
	document: { configurable: true, value: environment.window.document },
	Node: { configurable: true, value: environment.window.Node },
});
// The fixture owns the main-window registry for the file, outside each test's resource lifetime.
getWindows();
Object.defineProperties(environment.window, {
	innerWidth: { configurable: true, value: 800 },
	innerHeight: { configurable: true, value: 600 },
});
Object.defineProperty(environment.window.Element.prototype, 'scrollTo', {
	configurable: true,
	value(this: Element, left: number, top: number) { this.scrollLeft = left; this.scrollTop = top; },
});

const { BrowserContextViewService } = await import('../../../contextview/browser/contextViewService.js');
const { HoverService, IHoverService } = await import('../../browser/hoverService.js');

for (const reducedDelay of [false, true]) {
	test(`HoverService waits for the ${reducedDelay ? 'reduced' : 'platform'} default delay and cancels brief visits`, () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using configuration = new InMemoryConfigurationService();
			using contextViews = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
			using contextMenus = new TestContextMenuService();
			using service = new HoverService(configuration, contextViews, contextMenus);
			const target = requiredElement<HTMLButtonElement>('#first');
			using registration = service.setupDelayedHover(target, { content: 'Details' }, { reducedDelay });
			const delay = reducedDelay || !isMacintosh ? 500 : 1_500;
			const tooltip = (): Element | null => contextViews.container.querySelector('[role="tooltip"]');

			target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
			mock.timers.tick(delay - 1);
			assert.equal(tooltip(), null, 'Passing over a control must not immediately open its tooltip');
			target.dispatchEvent(new environment.window.MouseEvent('pointerleave'));
			mock.timers.tick(delay);
			assert.equal(tooltip(), null, 'Leaving before the delay must cancel the tooltip');

			target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
			mock.timers.tick(delay - 1);
			assert.equal(tooltip(), null, 'Returning to the control starts a full delay');
			mock.timers.tick(1);
			assert.equal(tooltip()?.textContent, 'Details');
		} finally {
			mock.timers.reset();
		}
	});

	test(`HoverService observes changes to the ${reducedDelay ? 'reduced' : 'standard'} configured delay`, async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using configuration = new InMemoryConfigurationService();
			using contextViews = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
			using contextMenus = new TestContextMenuService();
			using service = new HoverService(configuration, contextViews, contextMenus);
			const target = requiredElement<HTMLButtonElement>('#first');
			using registration = service.setupDelayedHover(target, { content: 'Configured details' }, { reducedDelay });
			await configuration.updateValue(reducedDelay ? HoverConfiguration.reducedDelay : HoverConfiguration.delay, 750);

			target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
			mock.timers.tick(749);
			assert.equal(contextViews.container.querySelector('[role="tooltip"]'), null);
			mock.timers.tick(1);
			assert.equal(contextViews.container.querySelector('[role="tooltip"]')?.textContent, 'Configured details');
		} finally {
			mock.timers.reset();
		}
	});
}

for (const dismissal of ['hide', 'menu', 'escape', 'blur'] as const) {
	test(`HoverService cancels a pending hover on ${dismissal}`, () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using configuration = new InMemoryConfigurationService();
			using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
			using menus = new TestContextMenuService();
			using service = new HoverService(configuration, views, menus);
			const target = requiredElement<HTMLButtonElement>('#first');
			using hover = service.setupHover({ target, content: 'Cancelled details' });
			target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
			if (dismissal === 'hide') { service.hideHover(); }
			if (dismissal === 'menu') { menus.show(); menus.hide(); }
			if (dismissal === 'escape') { target.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
			if (dismissal === 'blur') { environment.window.dispatchEvent(new environment.window.Event('blur')); }
			mock.timers.tick(2_000);
			assert.equal(hover.visible, false);
			assert.equal(views.container.querySelector('[role="tooltip"]'), null);
		} finally {
			mock.timers.reset();
		}
	});
}

test('HoverService closes plain hints on typing and keeps interactive content usable', () => {
	using configuration = new InMemoryConfigurationService();
	using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
	using menus = new TestContextMenuService();
	using service = new HoverService(configuration, views, menus);
	const target = requiredElement<HTMLButtonElement>('#first');
	using plain = service.setupHover({ target, content: 'Plain hint' });
	plain.show();
	target.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
	assert.equal(plain.visible, false);

	const input = h(environment.window.document, 'input');
	using interactive = service.setupHover({ target, content: input, trapFocus: true });
	interactive.show();
	input.focus();
	input.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
	assert.equal(interactive.visible, true);
});

test('HoverService holds a hint while Alt is down and releases it outside the target', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using configuration = new InMemoryConfigurationService();
		using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
		using menus = new TestContextMenuService();
		using service = new HoverService(configuration, views, menus);
		const target = requiredElement<HTMLButtonElement>('#first');
		using hover = service.setupHover({ target, content: 'Locked hint' });
		hover.show();
		target.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
		target.dispatchEvent(new environment.window.MouseEvent('pointerleave'));
		mock.timers.tick(500);
		assert.equal(hover.visible, true);
		target.dispatchEvent(new environment.window.KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
		assert.equal(hover.visible, false);
	} finally {
		mock.timers.reset();
	}
});

test('HoverService keeps a parent card open for nested hints and closes the focused child first', () => {
	using configuration = new InMemoryConfigurationService();
	using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
	using menus = new TestContextMenuService();
	using service = new HoverService(configuration, views, menus);
	const content = h(environment.window.document, 'div');
	const childTarget = h(environment.window.document, 'button', undefined, 'Copy');
	content.append(childTarget);
	using parent = service.setupHover({ target: requiredElement<HTMLButtonElement>('#first'), content });
	using child = service.setupHover({ target: childTarget, content: 'Copy hash' });
	parent.show();
	child.show(true);
	assert.equal(parent.visible, true);
	assert.equal(child.visible, true);
	assert.equal(views.container.querySelectorAll('[role="tooltip"]').length, 2);
	childTarget.dispatchEvent(new environment.window.MouseEvent('pointerdown', { bubbles: true }));
	assert.equal(parent.visible, true, 'A child trigger must stay inside its parent card');
	child.show(true);
	const childTooltip = environment.window.document.activeElement;
	assert.equal(childTooltip?.textContent, 'Copy hash');
	childTooltip?.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(child.visible, false);
	assert.equal(parent.visible, true);
	assert.equal(environment.window.document.activeElement, childTarget);
	child.show();
	parent.hide();
	assert.equal(child.visible, false);
	assert.equal(views.container.querySelectorAll('[role="tooltip"]').length, 0);
});

test('HoverService replaces sibling hints and dismisses the whole card chain for a context menu', () => {
	using configuration = new InMemoryConfigurationService();
	using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
	using menus = new TestContextMenuService();
	using service = new HoverService(configuration, views, menus);
	const content = h(environment.window.document, 'div');
	const first = h(environment.window.document, 'button');
	const second = h(environment.window.document, 'button');
	content.append(first, second);
	using parent = service.setupHover({ target: requiredElement<HTMLButtonElement>('#first'), content });
	using firstChild = service.setupHover({ target: first, content: 'First child' });
	using secondChild = service.setupHover({ target: second, content: 'Second child' });
	parent.show();
	firstChild.show();
	secondChild.show();
	assert.equal(parent.visible, true);
	assert.equal(firstChild.visible, false);
	assert.equal(secondChild.visible, true);
	menus.show();
	assert.equal(parent.visible, false);
	assert.equal(secondChild.visible, false);
	assert.equal(views.container.querySelectorAll('[role="tooltip"]').length, 0);
});

test('HoverService exposes the focused control through the registered Workbench command', () => {
	using configuration = new InMemoryConfigurationService();
	using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
	using menus = new TestContextMenuService();
	using service = new HoverService(configuration, views, menus);
	using services = new InstantiationService();
	services.registerInstance(IHoverService, service);
	services.registerInstance(ILayoutService, { activeContainer: views.container } as ILayoutService);
	const target = requiredElement<HTMLButtonElement>('#first');
	using hover = service.setupHover({ target, content: 'Keyboard details' });
	target.focus();
	const command = CommandsRegistry.getCommand('workbench.action.showHover');
	assert.ok(command);
	services.invokeFunction(accessor => command(accessor));
	const tooltip = views.container.querySelector('[role="tooltip"]');
	assert.equal(tooltip?.textContent, 'Keyboard details');
	assert.equal(environment.window.document.activeElement, tooltip);
	services.invokeFunction(accessor => command(accessor));
	assert.equal(views.container.querySelector('[role="tooltip"]'), tooltip);
});

test('HoverService accessible content survives dismissal and restores the live hover on close', () => {
	using configuration = new InMemoryConfigurationService();
	using views = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
	using menus = new TestContextMenuService();
	using service = new HoverService(configuration, views, menus);
	using services = new InstantiationService();
	services.registerInstance(IHoverService, service);
	using hover = service.setupHover({ target: requiredElement<HTMLButtonElement>('#first'), content: 'Readable details' });
	hover.show(true);
	const provider = services.invokeFunction(accessor => AccessibleViewRegistry.getImplementations()
		.filter(entry => entry.type === AccessibleViewType.View)
		.map(entry => entry.getProvider(accessor)).find(Boolean));
	assert.ok(provider);
	assert.equal(provider.id, AccessibleViewProviderId.Hover);
	service.hideHover();
	assert.equal(provider.provideContent(), 'Readable details');
	provider.dispose();
	assert.equal(hover.visible, true);
	assert.equal(environment.window.document.activeElement?.textContent, 'Readable details');
	hover.dispose();
	service.showAndFocusLastHover();
	assert.equal(views.container.querySelector('[role="tooltip"]'), null);
});

test('HoverService coordinates grouped Hovers and context menus', async () => {
	const container = requiredElement<HTMLElement>('main');
	const firstTarget = requiredElement<HTMLButtonElement>('#first');
	const secondTarget = requiredElement<HTMLButtonElement>('#second');
	firstTarget.getBoundingClientRect = () => rectangle(20, 60, 80, 24);
	secondTarget.getBoundingClientRect = () => rectangle(120, 60, 80, 24);
	const contextViews = new BrowserContextViewService(container);
	const contextViewElement = container.querySelector<HTMLElement>('.ash-context-view');
	assert.ok(contextViewElement);
	contextViewElement.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	const contextMenus = new TestContextMenuService();
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(HoverConfiguration.delay, 1_000);
	const hoverService = new HoverService(
		configuration,
		contextViews,
		contextMenus,
	);

	const first = hoverService.showHover({
		target: firstTarget,
		content: 'First Hover',
		groupId: 'test.items',
	});
	assert.equal(first.visible, true);
	assert.equal(contextViewElement.textContent, 'First Hover');

	const second = hoverService.setupHover({
		target: secondTarget,
		content: 'Second Hover',
		groupId: 'test.items',
		anchorAlignment: AnchorAlignment.Left,
		anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
		anchorPosition: AnchorPosition.Below,
		gap: 8,
	});
	secondTarget.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	await nextTimer();
	assert.equal(second.visible, true);
	assert.equal(first.visible, false);
	assert.equal(contextViewElement.textContent, 'Second Hover');
	assert.equal(contextViewElement.style.left, '208px');
	assert.equal(contextViewElement.style.top, '60px');
	assert.equal(contextViewElement.classList.contains('ash-context-view-axis-horizontal'), true);

	contextMenus.show();
	assert.equal(second.visible, false);
	firstTarget.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	await nextTimer();
	assert.equal(first.visible, false);

	contextMenus.hide();
	first.show();
	assert.equal(first.visible, true);
	hoverService.hideHover();
	assert.equal(first.visible, false);

	second.dispose();
	first.dispose();
	hoverService.dispose();
	contextMenus.dispose();
	contextViews.dispose();
});

test('HoverService reports dismissal so callers release each shown card', () => {
	using configuration = new InMemoryConfigurationService();
	using contextViews = new BrowserContextViewService(requiredElement<HTMLElement>('main'));
	using contextMenus = new TestContextMenuService();
	using service = new HoverService(configuration, contextViews, contextMenus);
	let hidden = 0;
	using hover = service.setupHover({
		target: requiredElement<HTMLButtonElement>('#first'),
		content: 'Details',
		onDidHide: () => hidden++,
	});
	hover.show();
	hover.hide();
	hover.hide();
	assert.equal(hidden, 1);
	hover.show();
	hover.dispose();
	assert.equal(hidden, 2);
});

test('HoverService suppresses replacement Hovers until the pointer moves after activation', async () => {
	const container = requiredElement<HTMLElement>('main');
	const previousTarget = h(environment.window.document, 'button');
	previousTarget.textContent = 'Previous Action';
	container.append(previousTarget);
	previousTarget.getBoundingClientRect = () => rectangle(20, 100, 100, 24);
	const target = h(environment.window.document, 'button');
	target.textContent = 'Action';
	container.append(target);
	target.getBoundingClientRect = () => rectangle(140, 100, 80, 24);
	const contextViews = new BrowserContextViewService(container);
	const contextViewElement = container.querySelector<HTMLElement>('.ash-context-view');
	assert.ok(contextViewElement);
	contextViewElement.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	const contextMenus = new TestContextMenuService();
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(HoverConfiguration.delay, 0);
	const hoverService = new HoverService(configuration, contextViews, contextMenus);
	const previousHover = hoverService.setupHover({ target: previousTarget, content: 'Previous Action Hover', groupId: 'actions' });
	const hover = hoverService.setupHover({ target, content: 'Action Hover', groupId: 'actions' });

	previousHover.show();
	assert.equal(previousHover.visible, true);
	target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	target.dispatchEvent(new environment.window.MouseEvent('pointerdown', { bubbles: true }));
	target.dispatchEvent(new environment.window.FocusEvent('focusin', { bubbles: true }));
	target.dispatchEvent(new environment.window.MouseEvent('pointerup', { bubbles: true }));
	target.dispatchEvent(new environment.window.MouseEvent('click', { bubbles: true }));
	assert.equal(previousHover.visible, false);
	assert.equal(hover.visible, false);

	const replacementTarget = h(environment.window.document, 'button');
	replacementTarget.textContent = 'Replacement Action';
	container.append(replacementTarget);
	replacementTarget.getBoundingClientRect = () => rectangle(140, 100, 80, 24);
	const replacementHover = hoverService.setupHover({ target: replacementTarget, content: 'Action Hover', groupId: 'actions' });
	replacementTarget.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	await nextTimer();
	assert.equal(replacementHover.visible, false);

	replacementTarget.dispatchEvent(new environment.window.MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 145, clientY: 100 }));
	replacementTarget.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	await nextTimer();
	assert.equal(replacementHover.visible, true);
	replacementHover.hide();

	target.dispatchEvent(new environment.window.FocusEvent('focusout', { bubbles: true }));
	target.dispatchEvent(new environment.window.FocusEvent('focusin', { bubbles: true }));
	assert.equal(hover.visible, false);
	target.dispatchEvent(new environment.window.FocusEvent('focusin', { bubbles: true, relatedTarget: previousTarget }));
	await nextTimer();
	assert.equal(hover.visible, true);

	hoverService.dispose();
	contextMenus.dispose();
	contextViews.dispose();
	previousTarget.remove();
	target.remove();
	replacementTarget.remove();
});

test('HoverService focuses a requested keyboard hover', () => {
	const container = requiredElement<HTMLElement>('main');
	const target = h(environment.window.document, 'div');
	target.tabIndex = 0;
	container.append(target);
	target.getBoundingClientRect = () => rectangle(20, 100, 80, 24);
	const contextViews = new BrowserContextViewService(container);
	const contextMenus = new TestContextMenuService();
	using configuration = new InMemoryConfigurationService();
	const hoverService = new HoverService(configuration, contextViews, contextMenus);
	const hover = hoverService.setupHover({ target, content: 'Keyboard hover', setupKeyboardEvents: true });

	target.focus();
	target.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(environment.window.document.activeElement, container.querySelector('.ash-hover'));
	assert.equal(hover.visible, true);

	hoverService.dispose();
	contextMenus.dispose();
	contextViews.dispose();
	target.remove();
});

test('HoverService resolves delayed content and position once at display time', async () => {
	const container = requiredElement<HTMLElement>('main');
	const target = requiredElement<HTMLButtonElement>('#first');
	target.getBoundingClientRect = () => rectangle(200, 200, 80, 24);
	using contextViews = new BrowserContextViewService(container);
	const contextViewElement = container.querySelector<HTMLElement>('.ash-context-view');
	assert.ok(contextViewElement);
	contextViewElement.getBoundingClientRect = () => rectangle(0, 0, 120, 40);
	using contextMenus = new TestContextMenuService();
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(HoverConfiguration.delay, 0);
	using hoverService = new HoverService(configuration, contextViews, contextMenus);
	let position = HoverPosition.RIGHT;
	let content = 'Initial';
	let evaluations = 0;
	using registration = hoverService.setupDelayedHover(target, () => {
		evaluations++;
		return { content, position: { hoverPosition: position } };
	});
	assert.equal(evaluations, 0);

	const displayed = new Promise<void>(resolve => {
		const observer = new environment.window.MutationObserver(() => {
			if (!contextViewElement.querySelector('[role="tooltip"]')) return;
			observer.disconnect();
			resolve();
		});
		observer.observe(contextViewElement, { childList: true, subtree: true });
	});
	target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	position = HoverPosition.LEFT;
	content = 'Current';
	await displayed;
	assert.equal(evaluations, 1);
	assert.equal(contextViewElement.textContent, 'Current');
	assert.equal(contextViewElement.style.left, '74px');
	assert.equal(contextViewElement.classList.contains('ash-context-view-axis-horizontal'), true);
	assert.ok(target.hasAttribute('aria-describedby'));
	hoverService.hideHover();
	assert.equal(target.hasAttribute('aria-describedby'), false);

	position = HoverPosition.BELOW;
	registration.dispose();
	target.dispatchEvent(new environment.window.MouseEvent('pointerenter'));
	assert.equal(evaluations, 1);
});

class TestContextMenuService extends Disposable implements IContextMenuService {
	readonly contextMenuStyle = 'custom';
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	show(): void {
		this._onDidShowContextMenu.fire();
	}

	hide(): void {
		this._onDidHideContextMenu.fire();
	}

	showContextMenu(): void { }
	hideContextMenu(): void { }
}

function requiredElement<T extends Element>(selector: string): T {
	const element = environment.window.document.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

async function nextTimer(): Promise<void> {
	await new Promise<void>((resolve) => environment.window.setTimeout(resolve, 5));
}

suite('HoverService browser interaction', () => {
	const browser = useBrowserTests();
	test('nested action hints retain their card and clicking an action stays inside it', async () => {
		const { page } = browser;
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/hover.html');
		await page.getByRole('button', { name: 'Details', exact: true }).hover();
		const parent = page.getByRole('tooltip').filter({ has: page.getByRole('button', { name: 'Copy', exact: true }) });
		await expect(parent).toBeVisible();
		const copy = parent.getByRole('button', { name: 'Copy', exact: true });
		await copy.hover();
		const child = page.getByRole('tooltip', { name: 'Copy details', exact: true });
		await expect(child).toBeVisible();
		await expect(parent).toBeVisible();
		const [parentBounds, childBounds] = await Promise.all([parent.boundingBox(), child.boundingBox()]);
		assert.ok(parentBounds && childBounds);
		assert.ok(childBounds.y + childBounds.height <= parentBounds.y + parentBounds.height);
		const anchorOffset = Math.round(childBounds.y - (await copy.boundingBox())!.y);
		await parent.evaluate(element => { (element.firstElementChild as HTMLElement).style.paddingBottom = '40px'; });
		await expect.poll(async () => Math.round((await child.boundingBox())!.y - (await copy.boundingBox())!.y)).toBe(anchorOffset);
		await copy.click();
		await expect(page.getByRole('status')).toHaveText('Copied');
		await expect(parent).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('tooltip')).toHaveCount(0);
	});

	test('independent toolbars each wait before showing their first hint', async () => {
		const { page } = browser;
		await page.goto('/hover.html');
		await page.clock.install();
		await page.clock.pauseAt(new Date());
		await page.getByRole('button', { name: 'First action', exact: true }).hover();
		await page.clock.runFor(100);
		await expect(page.getByRole('tooltip')).toHaveText('First hint');
		await page.getByRole('button', { name: 'Other action', exact: true }).hover();
		await page.clock.runFor(99);
		await expect(page.getByRole('tooltip')).toHaveCount(0);
		await page.clock.runFor(1);
		await expect(page.getByRole('tooltip')).toHaveText('Other hint');
	});
});
