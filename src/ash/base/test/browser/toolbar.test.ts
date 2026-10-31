import type { IDelayedHoverOptions } from '../../browser/ui/hover/hover.js';
import { HoverPosition } from '../../browser/ui/hover/hoverWidget.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { JSDOM } from 'jsdom';
import type { IContextMenuDelegate, IContextMenuProvider } from '../../browser/contextmenu.js';
import { setHoverDelegate, type IManagedHover } from '../../browser/ui/hover/hoverDelegate.js';
import { ToolBar } from '../../browser/ui/toolbar/toolbar.js';
import type { IAction } from '../../common/actions.js';
import { ActionRunner, Separator } from '../../common/actions.js';
import { AnchorPosition } from '../../common/layout.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('ToolBar shares a borrowed runner while an open menu retains its captured context', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const provider = new TestContextMenuProvider();
		using runner = new ActionRunner();
		const calls: unknown[] = [];
		const operation = { ...action('operation'), run(context: unknown) { calls.push(context); } };
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider: provider, actionRunner: runner });
		toolbar.context = 'first';
		toolbar.setActions([operation], [operation]);
		toolbar.element.querySelector<HTMLButtonElement>('[data-action-id="operation"] button')!.click();
		using listener = toolbar.onDidChangeDropdownVisibility(visible => {
			if (visible) toolbar.context = 'changed during opening';
		});
		toolbar.element.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
		toolbar.context = 'second';
		const menu = provider.lastOptions!;
		assert.equal(menu.actionRunner, runner);
		await menu.actionRunner!.run(menu.getActions()[0]!, menu.getActionsContext?.());
		assert.deepEqual(calls, ['first', 'first']);
		menu.onHide?.(false);
		toolbar.dispose();
		await runner.run(operation, 'after disposal');
		assert.deepEqual(calls, ['first', 'first', 'after disposal'], 'The supplied runner remains owned by its caller');
	} finally { dom.window.close(); }
});

test('ToolBar preserves focusability across action replacement and reports its rendered actions', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider: new TestContextMenuProvider() });
		toolbar.setFocusable(false);
		toolbar.setActions([action('first'), action('second')]);
		assert.deepEqual([...toolbar.element.querySelectorAll('button')].map(button => button.tabIndex), [-1, -1]);
		toolbar.focus(1);
		const focused = dom.window.document.activeElement as HTMLElement;
		assert.equal(toolbar.getItemAction(focused)?.id, 'second');
		toolbar.setActions([action('first'), action('second'), action('third')]);
		assert.deepEqual([...toolbar.element.querySelectorAll('button')].map(button => button.tabIndex), [-1, -1, -1]);
		toolbar.setFocusable(true);
		assert.equal(dom.window.document.activeElement?.getAttribute('tabindex'), '0');
		assert.equal(toolbar.getItemsLength(), 3);
	} finally { dom.window.close(); }
});

test('ToolBar reports menu visibility once per presentation and drops removed item listeners', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const provider = new TestContextMenuProvider();
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider: provider });
		const visibility: boolean[] = [];
		using listener = toolbar.onDidChangeDropdownVisibility(value => visibility.push(value));
		toolbar.setActions([], [action('secondary')]);
		toolbar.element.querySelector('button')!.click();
		const menu = provider.lastOptions!;
		toolbar.setActions([action('replacement')]);
		assert.deepEqual(visibility, [true]);
		menu.onHide?.(true);
		await Promise.resolve();
		assert.deepEqual(visibility, [true, false]);
		assert.equal(toolbar.getItemAction(0)?.id, 'replacement');
		menu.onHide?.(true);
		assert.deepEqual(visibility, [true, false]);
	} finally { dom.window.close(); }
});

test('ToolBar repeated actions keep DOM and Tab stops unchanged while enabled-state changes still move the stop', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider: new TestContextMenuProvider() });
		let enabled = true;
		const primary = { ...action('primary'), get enabled() { return enabled; } };
		const secondary = action('secondary');
		toolbar.setActions([primary], [secondary]);
		const first = toolbar.element.querySelector<HTMLButtonElement>('[data-action-id="primary"] button')!;
		const more = toolbar.element.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
		first.focus();
		const observer = new dom.window.MutationObserver(() => { });
		observer.observe(toolbar.element, { subtree: true, childList: true, attributes: true });
		try {
			for (let iteration = 0; iteration < 20; iteration++) toolbar.setActions([primary], [secondary]);
			assert.equal(observer.takeRecords().length, 0, 'identical action updates must not mutate the toolbar');
			assert.equal(dom.window.document.activeElement, first);
			enabled = false;
			toolbar.setActions([primary], [secondary]);
			assert.equal(first.tabIndex, -1);
			assert.equal(more.tabIndex, 0);
			toolbar.setActions([primary, action('added')], [secondary]);
			assert.equal(toolbar.element.querySelector('[data-action-id="primary"] button'), first);
			assert.equal(toolbar.element.querySelector('[aria-haspopup="menu"]'), more);
			assert.equal(toolbar.element.querySelector<HTMLButtonElement>('[data-action-id="added"] button')!.tabIndex, -1);
		} finally { observer.disconnect(); }
	} finally { dom.window.close(); }
});

test('ToolBar renders primary actions and trails More Actions', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const contextMenuProvider = new TestContextMenuProvider();
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider,
		ariaLabel: 'Test actions',
	});
	toolbar.setActions(
		[action('primary')],
		[action('secondary')],
	);
	dom.window.document.body.append(toolbar.element);

	const buttons = toolbar.element.querySelectorAll('button');
	assert.equal(toolbar.element.getAttribute('role'), 'toolbar');
	assert.equal(toolbar.element.getAttribute('aria-label'), 'Test actions');
	assert.equal(toolbar.element.classList.contains('ash-toolbar-default'), true);
	assert.equal(buttons.length, 2);
	assert.equal(buttons[0]?.textContent, 'primary');
	assert.equal(buttons[0]?.getAttribute('aria-label'), 'primary');
	assert.equal(buttons[1]?.title, 'More Actions');
	assert.equal(buttons[1]?.getAttribute('aria-haspopup'), 'menu');
	assert.equal(toolbar.element.textContent?.includes('secondary'), false);

	buttons[1]?.click();
	assert.deepEqual(
		contextMenuProvider.lastOptions?.getActions().map(({ id }) => id),
		['secondary'],
	);
	assert.equal(buttons[1]?.getAttribute('aria-expanded'), 'true');
	assert.equal(buttons[1]?.classList.contains('active'), true);
	contextMenuProvider.lastOptions?.onHide?.(false);
	assert.equal(buttons[1]?.getAttribute('aria-expanded'), 'false');
	assert.equal(buttons[1]?.classList.contains('active'), false);

	toolbar.dispose();
	dom.window.close();
});

test('ToolBar exposes component-owned foreground presentations', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		presentation: 'inherit-foreground',
	});

	assert.equal(toolbar.element.classList.contains('ash-toolbar-inherit-foreground'), true);

	toolbar.dispose();
	dom.window.close();
});

test('ToolBar cancels only its open menu and waits for the provider to finish closing', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const contextMenuProvider = new TestContextMenuProvider();
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider });
		toolbar.setActions([], [action('secondary')]);
		const trigger = toolbar.element.querySelector('button')!;
		trigger.click();
		const first = contextMenuProvider.lastOptions!;
		assert.equal(first.cancellationToken?.isCancellationRequested, false);

		trigger.click();
		assert.equal(first.cancellationToken?.isCancellationRequested, true);
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		trigger.click();
		assert.equal(contextMenuProvider.lastOptions, first);
		first.onHide?.(true);
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');
		assert.equal(trigger.classList.contains('active'), false);

		trigger.click();
		const second = contextMenuProvider.lastOptions!;
		assert.notEqual(second, first);
		assert.equal(second.cancellationToken?.isCancellationRequested, false);
		// A delayed notification from the previous presentation cannot collapse its successor.
		first.onHide?.(true);
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		toolbar.dispose();
		assert.equal(second.cancellationToken?.isCancellationRequested, true);
		second.onHide?.(true);
	} finally {
		dom.window.close();
	}
});

test('ToolBar highlights checked actions only when requested', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		highlightToggledItems: true,
	});
	toolbar.setActions([{ ...action('checked'), checked: true }]);

	const button = toolbar.element.querySelector('button');
	assert.equal(toolbar.element.classList.contains('highlight-toggled'), true);
	assert.equal(button?.classList.contains('checked'), true);
	assert.equal(button?.getAttribute('aria-pressed'), 'true');

	toolbar.dispose();
	dom.window.close();
});

test('ToolBar applies its hover anchor position to primary and More Actions items', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const setups: Pick<IDelayedHoverOptions, 'position'>[] = [];
	using delegateRegistration = setHoverDelegate({
		setupHover(options) {
			setups.push({ position: { hoverPosition: options.anchorPosition === AnchorPosition.Below ? HoverPosition.BELOW : HoverPosition.ABOVE } });
			return managedHover();
		},
		setupDelayedHover(target, options, lifecycleOptions) {
			setups.push({ ...(typeof options === 'function' ? options() : options), ...lifecycleOptions });
			target.removeAttribute('title');
			return managedHover();
		},
	});
	using toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		hoverAnchorPosition: AnchorPosition.Below,
	});
	toolbar.setActions([action('primary')], [action('secondary')]);

	assert.deepEqual(setups.map(({ position }) => position?.hoverPosition), [HoverPosition.BELOW, HoverPosition.BELOW]);

	dom.window.close();
});

test('ToolBar omits More Actions when secondary actions are empty', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
	});
	toolbar.setActions(
		[new Separator(), action('primary'), new Separator()],
		[new Separator()],
	);

	const buttons = toolbar.element.querySelectorAll('button');
	assert.equal(buttons.length, 1);
	assert.equal(buttons[0]?.textContent, 'primary');

	toolbar.dispose();
	dom.window.close();
});

test('ToolBar can place More Actions before a named primary action', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		moreActionsPlacement: { beforeActionId: 'maximize' },
	});
	toolbar.setActions(
		[action('kill'), action('maximize'), action('close')],
		[action('clear')],
		[action('account'), action('manage')],
	);

	assert.deepEqual(
		[...toolbar.element.querySelectorAll<HTMLElement>('[data-action-id]')]
			.map((item) => item.dataset.actionId),
		['kill', 'ash.toolbar.moreActions', 'maximize', 'close', 'account', 'manage'],
	);

	toolbar.dispose();
	dom.window.close();
});

test('ToolBar folds measured action widths into More Actions and restores their order and focus', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const provider = new TestContextMenuProvider();
		let width = 240;
		using toolbar = new ToolBar(dom.window.document.body, {
			contextMenuProvider: provider,
			responsiveBehavior: { enabled: true, getAvailableWidth: () => width },
		});
		toolbar.element.style.columnGap = '4px';
		dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
			return { width: this.dataset.actionId === 'filter' ? 70 : 22 } as DOMRect;
		};
		const operations = ['filter', 'pull', 'push', 'refresh'].map(action);
		const view = action('view');
		toolbar.setActions(operations, [view]);
		const filter = toolbar.element.querySelector('[data-action-id="filter"]');
		toolbar.element.querySelector<HTMLButtonElement>('[data-action-id="refresh"] button')!.focus();
		width = 110;
		toolbar.relayout();
		assert.deepEqual([...toolbar.element.children].map(item => (item as HTMLElement).dataset.actionId), ['filter', 'ash.toolbar.moreActions']);
		const more = toolbar.element.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
		assert.equal(dom.window.document.activeElement, more);
		more.click();
		assert.deepEqual(provider.lastOptions!.getActions().map(item => item.id), ['pull', 'push', 'refresh', Separator.ID, 'view']);
		provider.lastOptions!.onHide?.(true);
		width = 240;
		toolbar.relayout();
		assert.deepEqual([...toolbar.element.children].map(item => (item as HTMLElement).dataset.actionId), ['filter', 'pull', 'push', 'refresh', 'ash.toolbar.moreActions']);
		assert.equal(toolbar.element.querySelector('[data-action-id="filter"]'), filter);
	} finally { dom.window.close(); }
});

test('ToolBar reserves a menu trigger even without secondary actions and invokes the original overflow action', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const provider = new TestContextMenuProvider();
		let width = 22;
		using toolbar = new ToolBar(dom.window.document.body, {
			contextMenuProvider: provider,
			responsiveBehavior: { enabled: true, getAvailableWidth: () => width },
		});
		dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 22 }) as DOMRect;
		toolbar.element.style.columnGap = '4px';
		let calls = 0;
		const first = { ...action('first'), run() { calls++; } };
		const disabled = { ...action('disabled'), enabled: false };
		toolbar.setActions([first, disabled]);
		toolbar.relayout();
		assert.equal(toolbar.element.children.length, 1);
		toolbar.element.querySelector<HTMLButtonElement>('button')!.click();
		const menuActions = provider.lastOptions!.getActions();
		assert.deepEqual(menuActions, [first, disabled]);
		await menuActions[0]!.run();
		assert.equal(calls, 1);
		provider.lastOptions!.onHide?.(true);
		await Promise.resolve();
		width = 48;
		toolbar.relayout();
		assert.deepEqual([...toolbar.element.children].map(item => (item as HTMLElement).dataset.actionId), ['first', 'disabled']);
		assert.equal(toolbar.element.querySelector('[aria-haspopup="menu"]'), null);
	} finally { dom.window.close(); }
});

class TestContextMenuProvider implements IContextMenuProvider {
	lastOptions: IContextMenuDelegate | undefined;

	showContextMenu(options: IContextMenuDelegate): void {
		this.lastOptions = options;
	}
}

function action(id: string): IAction {
	return {
		id,
		label: id,
		tooltip: id,
		enabled: true,
		run() { },
	};
}

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() { },
		hide() { },
		update() { },
		dispose() { },
		[Symbol.dispose]() { },
	};
}

suite('ToolBar browser foundation', () => {
	const browser = useBrowserTests();
	for (const [locale, theme] of [['en', 'hcLight'], ['zh-CN', 'dark']] as const) {
		test(`resizes with keyboard focus and preserves an open menu and its execution context (${locale}, ${theme})`, async () => {
			const { page } = browser;
			await page.goto(`/button.html?locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.evaluate(value => window.ashButtonIntegration.theme(value), theme);
			const host = page.locator('#foundation-toolbar');
			const toolbar = host.getByRole('toolbar');
			await expect(toolbar.getByRole('button')).toHaveCount(4);
			await toolbar.getByRole('button', { name: 'Second operation', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			await expect(toolbar.getByRole('button', { name: 'Third operation', exact: true })).toBeFocused();
			await page.evaluate(() => window.ashButtonIntegration.resizeFoundationToolbar(35));
			await expect(toolbar.getByRole('button')).toHaveCount(1);
			const more = toolbar.locator('[aria-haspopup="menu"]');
			await expect(more).toBeFocused();
			const geometry = await host.evaluate(element => {
				const host = element.getBoundingClientRect();
				const button = element.querySelector('button')!.getBoundingClientRect();
				return { hostRight: host.right, actionRight: button.right };
			});
			expect(geometry.actionRight).toBeLessThanOrEqual(geometry.hostRight + 1);
			await page.keyboard.press('ArrowDown');
			await expect(host).toHaveAttribute('data-dropdown-visible', 'true');
			await expect(page.getByRole('menu')).toBeVisible();
			await page.evaluate(() => {
				window.ashButtonIntegration.setFoundationContext('updated');
				window.ashButtonIntegration.resizeFoundationToolbar(600);
			});
			await expect(more).toHaveAttribute('aria-expanded', 'true');
			await page.getByRole('menuitem', { name: 'Secondary operation', exact: true }).click();
			await expect(host).toHaveAttribute('data-dropdown-visible', 'false');
			await expect(toolbar.getByRole('button')).toHaveCount(4);
			expect(await page.evaluate(() => window.ashButtonIntegration.foundationRuns())).toEqual([{ action: 'secondary', context: 'initial' }]);
			await toolbar.getByRole('button', { name: 'First operation', exact: true }).click();
			expect(await page.evaluate(() => window.ashButtonIntegration.foundationRuns())).toEqual([
				{ action: 'secondary', context: 'initial' }, { action: 'First operation', context: 'updated' },
			]);
		});
	}
});
