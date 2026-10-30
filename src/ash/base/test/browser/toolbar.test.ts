import type { IDelayedHoverOptions } from '../../browser/ui/hover/hover.js';
import { HoverPosition } from '../../browser/ui/hover/hoverWidget.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuDelegate, IContextMenuProvider } from '../../browser/contextmenu.js';
import { setHoverDelegate, type IManagedHover } from '../../browser/ui/hover/hoverDelegate.js';
import { ToolBar } from '../../browser/ui/toolbar/toolbar.js';
import type { IAction } from '../../common/actions.js';
import { Separator } from '../../common/actions.js';
import { AnchorPosition } from '../../common/layout.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

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
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider: provider });
		toolbar.element.style.columnGap = '4px';
		dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
			return { width: this.dataset.actionId === 'filter' ? 70 : 22 } as DOMRect;
		};
		const operations = ['filter', 'pull', 'push', 'refresh'].map(action);
		const view = action('view');
		toolbar.setActions(operations, [view]);
		const filter = toolbar.element.querySelector('[data-action-id="filter"]');
		toolbar.element.querySelector<HTMLButtonElement>('[data-action-id="refresh"] button')!.focus();
		toolbar.layout(110);
		assert.deepEqual([...toolbar.element.children].map(item => (item as HTMLElement).dataset.actionId), ['filter', 'ash.toolbar.moreActions']);
		const more = toolbar.element.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
		assert.equal(dom.window.document.activeElement, more);
		more.click();
		assert.deepEqual(provider.lastOptions!.getActions().map(item => item.id), ['pull', 'push', 'refresh', Separator.ID, 'view']);
		provider.lastOptions!.onHide?.(true);
		toolbar.layout(240);
		assert.deepEqual([...toolbar.element.children].map(item => (item as HTMLElement).dataset.actionId), ['filter', 'pull', 'push', 'refresh', 'ash.toolbar.moreActions']);
		assert.equal(toolbar.element.querySelector('[data-action-id="filter"]'), filter);
	} finally { dom.window.close(); }
});

test('ToolBar reserves a menu trigger even without secondary actions and invokes the original overflow action', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const provider = new TestContextMenuProvider();
		using toolbar = new ToolBar(dom.window.document.body, { contextMenuProvider: provider });
		dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 22 }) as DOMRect;
		toolbar.element.style.columnGap = '4px';
		let calls = 0;
		const first = { ...action('first'), run() { calls++; } };
		const disabled = { ...action('disabled'), enabled: false };
		toolbar.setActions([first, disabled]);
		toolbar.layout(22);
		assert.equal(toolbar.element.children.length, 1);
		toolbar.element.querySelector<HTMLButtonElement>('button')!.click();
		const menuActions = provider.lastOptions!.getActions();
		assert.deepEqual(menuActions, [first, disabled]);
		await menuActions[0]!.run();
		assert.equal(calls, 1);
		provider.lastOptions!.onHide?.(true);
		await Promise.resolve();
		toolbar.layout(48);
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
