import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { teardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
// Load browser module lifetimes before per-test disposable tracking and temporary windows.
import '../../browser/ui/menu/menu.js';
import { getWindows } from '../../browser/window.js';
import type { IAction } from '../../common/actions.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

// Temporary windows have no application shutdown owner for their registered resources.
teardown(() => { for (const window of getWindows()) window.disposables.dispose(); });
ensureNoDisposablesAreLeakedInTestSuite();

test('Menu constructs recursive action graphs one level at a time and releases opened levels', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(dom, ['Node']);
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const children: IAction[] = [];
	const action = new SubmenuAction('recursive', 'Recursive', children);
	children.push(action);
	const menu = new Menu(dom.window.document.body, [action], {}, unthemedMenuStyles);
	try {
		assert.equal(dom.window.document.querySelectorAll('[role="menu"]').length, 1);
		const trigger = menu.getContainer().querySelector<HTMLButtonElement>('button')!;
		trigger.click();
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		assert.equal(dom.window.document.querySelectorAll('[role="menu"]').length, 2);
		menu.closeSubmenus();
		assert.equal(dom.window.document.querySelectorAll('.ash-context-view-menu:not([hidden])').length, 0);
	} finally {
		menu.dispose();
		assert.equal(dom.window.document.body.childElementCount, 0);
		dom.window.close();
	}
});

test('Menu reads child state on first expansion and reuses controls when reopened', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(dom, ['Node']);
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const child = { id: 'child', label: 'Child', tooltip: '', enabled: true, run(): void { } };
	const menu = new Menu(dom.window.document.body, [new SubmenuAction('parent', 'Parent', [child])], {}, unthemedMenuStyles);
	try {
		const trigger = menu.getContainer().querySelector<HTMLButtonElement>('button')!;
		child.enabled = false;
		trigger.click();
		const button = dom.window.document.querySelector<HTMLButtonElement>('[data-action-id="child"] button')!;
		assert.equal(button.disabled, true);
		menu.closeSubmenus();
		child.enabled = true;
		menu.update();
		trigger.click();
		assert.equal(dom.window.document.querySelector('[data-action-id="child"] button'), button);
		assert.equal(button.disabled, false);
	} finally {
		menu.dispose();
		dom.window.close();
	}
});

test('Menu renders submenu actions with the shared SVG indicator', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, 'Node', {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const menu = new Menu(dom.window.document.body, [new SubmenuAction('test.submenu', 'More', [])], {}, unthemedMenuStyles);
	dom.window.document.body.append(menu.getContainer());

	const menuItem = menu.getContainer().querySelector('[role="menuitem"]');
	assert.ok(menuItem instanceof dom.window.HTMLButtonElement);
	assert.equal(menuItem.getAttribute('aria-haspopup'), 'menu');
	assert.equal(menuItem.getAttribute('aria-expanded'), 'false');
	const indicator = menuItem.querySelector('.ash-submenu-indicator');
	assert.ok(indicator instanceof dom.window.HTMLSpanElement);
	const icon = indicator.querySelector(':scope > .ash-icon');
	assert.ok(icon instanceof dom.window.HTMLSpanElement);
	assert.equal(icon.getAttribute('aria-hidden'), 'true');
	assert.equal(indicator.textContent, '');

	menu.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, 'window');
	Reflect.deleteProperty(globalThis, 'Node');
});

test('Menu renders action badges as trailing metadata', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, 'Node', {
		configurable: true,
		value: dom.window.Node,
	});
	const { Menu, unthemedMenuStyles } = await import('../../browser/ui/menu/menu.js');
	const menu = new Menu(dom.window.document.body, [{
		id: 'test.badge',
		label: 'Model',
		tooltip: 'Model',
		badge: 'Subscription',
		enabled: true,
		run(): void { },
	}], {}, unthemedMenuStyles);

	assert.equal(menu.getContainer().querySelector('.ash-menu-badge')?.textContent, 'Subscription');

	menu.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, 'window');
	Reflect.deleteProperty(globalThis, 'Node');
});

test('Menu items keep accessible names without installing action tooltips', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const [{ Menu, unthemedMenuStyles }, { setHoverDelegate }] = await Promise.all([
		import('../../browser/ui/menu/menu.js'),
		import('../../browser/ui/hover/hoverDelegate.js'),
	]);
	using hoverDelegate = setHoverDelegate({
		setupDelayedHover() { throw new Error('Unexpected delayed hover registration'); },
		setupHover(): never {
			throw new Error('Menu items must not install tooltips');
		},
	});
	const menu = new Menu(dom.window.document.body, [{
		id: 'plan',
		label: 'Plan',
		tooltip: 'Use Plan mode',
		enabled: true,
		run(): void { },
	}], {}, unthemedMenuStyles);
	const item = menu.getContainer().querySelector<HTMLButtonElement>("[role='menuitem']");
	assert.equal(item?.getAttribute('aria-label'), 'Plan');
	assert.equal(item?.hasAttribute('title'), false);
	menu.dispose();
	dom.window.close();
});

test('Menu projects one focused item for keyboard and pointer navigation', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, 'Node', {
		configurable: true,
		value: dom.window.Node,
	});
	const { Menu, unthemedMenuStyles } = await import('../../browser/ui/menu/menu.js');
	const menu = new Menu(dom.window.document.body, ['first', 'second', 'third'].map((id) => ({
		id,
		label: id,
		tooltip: id,
		enabled: true,
		run(): void { },
	})), {}, unthemedMenuStyles);
	dom.window.document.body.append(menu.getContainer());
	const items = [...menu.getContainer().querySelectorAll<HTMLElement>(
		':scope > .ash-action-view-item',
	)];
	const buttons = items.map((item) =>
		item.querySelector<HTMLButtonElement>(':scope > .ash-button')!
	);
	for (const button of buttons) {
		button.getClientRects = () => [{}] as unknown as DOMRectList;
	}
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', {
		configurable: true,
		value(): void { },
	});

	menu.focus(false);
	assert.equal(dom.window.document.activeElement, menu.getContainer());
	assert.equal(items.some((item) => item.classList.contains('focused')), false);
	menu.getContainer().dispatchEvent(new dom.window.KeyboardEvent('keydown', {
		bubbles: true,
		key: 'ArrowUp',
	}));
	assert.equal(dom.window.document.activeElement, buttons[2]);

	menu.focus(true);
	assert.equal(dom.window.document.activeElement, buttons[0]);
	assert.deepEqual(items.map((item) => item.classList.contains('focused')), [
		true,
		false,
		false,
	]);

	buttons[1]!.dispatchEvent(new dom.window.MouseEvent('mouseover', {
		bubbles: true,
		relatedTarget: buttons[0],
	}));
	buttons[1]!.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }));
	assert.equal(dom.window.document.activeElement, buttons[0]);
	const movement = new dom.window.MouseEvent('mousemove', { bubbles: true });
	Object.defineProperty(movement, 'movementX', { value: 1 });
	buttons[1]!.dispatchEvent(movement);
	assert.equal(dom.window.document.activeElement, buttons[1]);
	assert.deepEqual(items.map((item) => item.classList.contains('focused')), [
		false,
		true,
		false,
	]);

	buttons[1]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
		bubbles: true,
		key: 'ArrowDown',
	}));
	assert.equal(dom.window.document.activeElement, buttons[2]);
	assert.deepEqual(items.map((item) => item.classList.contains('focused')), [
		false,
		false,
		true,
	]);

	menu.getContainer().dispatchEvent(new dom.window.MouseEvent('mouseout', {
		bubbles: true,
		relatedTarget: dom.window.document.body,
	}));
	assert.equal(items.some((item) => item.classList.contains('focused')), false);

	menu.dispose();
	dom.window.close();
	Reflect.deleteProperty(globalThis, 'window');
	Reflect.deleteProperty(globalThis, 'Node');
});

test('Menu delays first expansion and switches only while a sibling remains expanded', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	mock.timers.enable({ apis: ['setTimeout'] });
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', {
		configurable: true,
		value(): void { },
	});
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, 'Node', {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const menu = new Menu(dom.window.document.body, [
		new SubmenuAction('first', 'First', [{
			id: 'first.child',
			label: 'First child',
			tooltip: 'First child',
			enabled: true,
			run(): void { },
		}]),
		new SubmenuAction('second', 'Second', [{
			id: 'second.child',
			label: 'Second child',
			tooltip: 'Second child',
			enabled: true,
			run(): void { },
		}]),
	], {}, unthemedMenuStyles);
	const first = menu.getContainer().querySelector<HTMLButtonElement>('[data-action-id="first"] button')!;
	const second = menu.getContainer().querySelector<HTMLButtonElement>('[data-action-id="second"] button')!;
	const firstContainer = first.parentElement!;
	const movePointer = (button: HTMLButtonElement, previous: Element): void => {
		button.dispatchEvent(new dom.window.MouseEvent('mouseover', {
			bubbles: true,
			relatedTarget: previous,
		}));
		const movement = new dom.window.MouseEvent('mousemove', { bubbles: true });
		Object.defineProperty(movement, 'movementX', { value: 1 });
		button.dispatchEvent(movement);
	};

	try {
		first.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
		mock.timers.tick(250);
		assert.equal(first.getAttribute('aria-expanded'), 'false');

		movePointer(first, dom.window.document.body);
		firstContainer.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
		mock.timers.tick(250);
		assert.equal(first.getAttribute('aria-expanded'), 'false');

		movePointer(first, dom.window.document.body);
		mock.timers.tick(249);
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(1);
		assert.equal(first.getAttribute('aria-expanded'), 'true');

		firstContainer.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
		movePointer(second, first);
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		assert.equal(second.getAttribute('aria-expanded'), 'true');
		assert.equal(dom.window.document.querySelectorAll('.ash-context-view-menu:not([hidden])').length, 1);
		mock.timers.tick(250);
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		assert.equal(second.getAttribute('aria-expanded'), 'true');

		second.parentElement!.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
		menu.closeSubmenus();
		movePointer(first, second);
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(249);
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(1);
		assert.equal(first.getAttribute('aria-expanded'), 'true');

		dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		firstContainer.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
		movePointer(second, first);
		assert.equal(second.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(249);
		assert.equal(second.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(1);
		assert.equal(second.getAttribute('aria-expanded'), 'true');
	} finally {
		menu.dispose();
		dom.window.close();
		Reflect.deleteProperty(globalThis, 'window');
		Reflect.deleteProperty(globalThis, 'Node');
		mock.timers.reset();
	}
});

test('Menu opens immediate root submenus only on movement without changing nested hover delay', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	mock.timers.enable({ apis: ['setTimeout'] });
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', {
		configurable: true,
		value(): void { },
	});
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, 'Node', {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const menu = new Menu(dom.window.document.body, [
		new SubmenuAction('first', 'First', [
			new SubmenuAction('nested', 'Nested', [{
				id: 'nested.child',
				label: 'Child',
				tooltip: 'Child',
				enabled: true,
				run(): void { },
			}]),
			new SubmenuAction('nested.second', 'Nested second', []),
		]),
		new SubmenuAction('second', 'Second', []),
	], {
		openSubmenusImmediatelyOnHover: true
	}, unthemedMenuStyles);
	const first = menu.getContainer().querySelector<HTMLButtonElement>('[data-action-id="first"] button')!;
	const second = menu.getContainer().querySelector<HTMLButtonElement>('[data-action-id="second"] button')!;
	const enter = (button: HTMLButtonElement): void => {
		button.parentElement!.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
	};
	const move = (button: HTMLButtonElement): void => {
		const movement = new dom.window.MouseEvent('mousemove', { bubbles: true });
		Object.defineProperty(movement, 'movementX', { value: 1 });
		button.dispatchEvent(movement);
	};
	const leave = (button: HTMLButtonElement): void => {
		button.parentElement!.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
	};

	try {
		enter(first);
		first.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }));
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		move(first);
		assert.equal(first.getAttribute('aria-expanded'), 'true');

		leave(first);
		enter(second);
		move(second);
		assert.equal(first.getAttribute('aria-expanded'), 'false');
		assert.equal(second.getAttribute('aria-expanded'), 'true');

		leave(second);
		enter(first);
		move(first);
		const nested = dom.window.document.querySelector<HTMLButtonElement>('.ash-context-view-menu:not([hidden]) [data-action-id="nested"] button')!;
		enter(nested);
		assert.equal(nested.getAttribute('aria-expanded'), 'false');
		const movement = new dom.window.MouseEvent('mousemove', { bubbles: true });
		Object.defineProperty(movement, 'movementX', { value: 1 });
		nested.dispatchEvent(movement);
		mock.timers.tick(249);
		assert.equal(nested.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(1);
		assert.equal(nested.getAttribute('aria-expanded'), 'true');

		const nestedSecond = dom.window.document.querySelector<HTMLButtonElement>('.ash-context-view-menu:not([hidden]) [data-action-id="nested.second"] button')!;
		leave(nested);
		enter(nestedSecond);
		move(nestedSecond);
		assert.equal(nested.getAttribute('aria-expanded'), 'false');
		assert.equal(nestedSecond.getAttribute('aria-expanded'), 'true');

		dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		leave(nestedSecond);
		enter(nested);
		move(nested);
		assert.equal(first.getAttribute('aria-expanded'), 'true');
		assert.equal(nested.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(249);
		assert.equal(nested.getAttribute('aria-expanded'), 'false');
		mock.timers.tick(1);
		assert.equal(nested.getAttribute('aria-expanded'), 'true');
	} finally {
		menu.dispose();
		dom.window.close();
		Reflect.deleteProperty(globalThis, 'window');
		Reflect.deleteProperty(globalThis, 'Node');
		mock.timers.reset();
	}
});

test('Menu preserves submenu focus and closes after focus leaves or the parent scrolls', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	mock.timers.enable({ apis: ['setTimeout'] });
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', {
		configurable: true,
		value(): void { },
	});
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, 'Node', {
		configurable: true,
		value: dom.window.Node,
	});
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const menu = new Menu(dom.window.document.body, [
		new SubmenuAction('submenu', 'Submenu', [{
			id: 'child',
			label: 'Child',
			tooltip: 'Child',
			enabled: true,
			run(): void { },
		}]),
		{
			id: 'leaf',
			label: 'Leaf',
			tooltip: 'Leaf',
			enabled: true,
			run(): void { },
		},
	], {}, unthemedMenuStyles);
	const trigger = menu.getContainer().querySelector<HTMLButtonElement>('[data-action-id="submenu"] button')!;
	const leaf = menu.getContainer().querySelector<HTMLButtonElement>('[data-action-id="leaf"] button')!;
	const movement = new dom.window.MouseEvent('mousemove', { bubbles: true });
	Object.defineProperty(movement, 'movementX', { value: 1 });

	try {
		trigger.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
		trigger.dispatchEvent(movement);
		mock.timers.tick(250);
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');

		const child = dom.window.document.querySelector<HTMLButtonElement>('.ash-context-view-menu:not([hidden]) [role="menuitem"]')!;
		child.focus();
		mock.timers.tick(750);
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');

		trigger.parentElement!.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
		leaf.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
		leaf.dispatchEvent(movement);
		mock.timers.tick(749);
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		mock.timers.tick(1);
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');
		assert.equal(dom.window.document.activeElement, leaf);

		trigger.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
		trigger.dispatchEvent(movement);
		mock.timers.tick(250);
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		const unrelatedScroller = dom.window.document.createElement('div');
		dom.window.document.body.append(unrelatedScroller);
		unrelatedScroller.dispatchEvent(new dom.window.Event('scroll'));
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		dom.window.document.body.dispatchEvent(new dom.window.Event('scroll'));
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	} finally {
		menu.dispose();
		dom.window.close();
		Reflect.deleteProperty(globalThis, 'window');
		Reflect.deleteProperty(globalThis, 'Node');
		mock.timers.reset();
	}
});

test('Menu restores its borrowed popup shell styles on disposal', async () => {
	const dom = new JSDOM("<!doctype html><body><div class='ash-context-view'></div></body>");
	const { Menu, unthemedMenuStyles } = await import('../../browser/ui/menu/menu.js');
	const shell = dom.window.document.querySelector<HTMLElement>('.ash-context-view')!;
	const border = '--ash-menu-style-border-color';
	const background = '--ash-menu-style-background-color';
	shell.style.setProperty(border, '#123456', 'important');
	const menu = new Menu(shell, [], {}, {
		...unthemedMenuStyles,
		foregroundColor: '#ffffff', backgroundColor: '#111111',
		selectionForegroundColor: '#ffffff', selectionBackgroundColor: '#222222',
		borderColor: '#333333', separatorColor: '#444444', shadowColor: '#555555',
	});
	try {
		assert.equal(shell.style.getPropertyValue(border), '#333333');
		assert.equal(shell.style.getPropertyValue(background), '#111111');
		menu.dispose();
		assert.equal(shell.style.getPropertyValue(border), '#123456');
		assert.equal(shell.style.getPropertyPriority(border), 'important');
		assert.equal(shell.style.getPropertyValue(background), '');
		assert.equal(shell.childElementCount, 0);
	} finally {
		menu.dispose();
		dom.window.close();
	}
});

test('Menu refreshes an open submenu without replacing controls and returns focus after selection', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
	Object.defineProperty(globalThis, 'Node', { configurable: true, value: dom.window.Node });
	Object.defineProperty(dom.window.Element.prototype, 'getClientRects', {
		configurable: true, value: () => [{}] as unknown as DOMRectList,
	});
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', { configurable: true, value(): void { } });
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'),
		import('../../browser/ui/menu/menu.js'),
	]);
	const stop = { id: 'stop', label: 'Stop', tooltip: '', enabled: true, run(): void { } };
	const menu = new Menu(dom.window.document.body, [new SubmenuAction('server', 'Server', [
		{ id: 'logs', label: 'Logs', tooltip: '', enabled: true, run(): void { } }, stop,
	])], {}, unthemedMenuStyles);
	try {
		const trigger = menu.getContainer().querySelector<HTMLButtonElement>('button')!;
		trigger.click();
		const submenu = dom.window.document.querySelector<HTMLElement>('.ash-context-view-menu [role="menu"]')!;
		const logs = submenu.querySelector<HTMLButtonElement>('[data-action-id="logs"] button')!;
		const stopButton = submenu.querySelector<HTMLButtonElement>('[data-action-id="stop"] button')!;
		stopButton.focus();
		stop.enabled = false;
		menu.update();
		assert.equal(stopButton.disabled, true);
		assert.equal(dom.window.document.activeElement, logs);
		assert.equal(submenu.querySelector('[data-action-id="stop"] button'), stopButton);
		stop.enabled = true;
		menu.update();
		assert.equal(stopButton.disabled, false);
		assert.equal(dom.window.document.activeElement, logs);
		logs.click();
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');
		assert.equal(dom.window.document.activeElement, trigger);
	} finally {
		menu.dispose();
		dom.window.close();
		Reflect.deleteProperty(globalThis, 'window');
		Reflect.deleteProperty(globalThis, 'Node');
	}
});


test('Menu updates mutable state and alternatives without replacing a focused control', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(dom, ['Node']);
	const [{ Action }, { Menu, unthemedMenuStyles }, { ModifierKeyEmitter }] = await Promise.all([
		import('../../common/actions.js'), import('../../browser/ui/menu/menu.js'), import('../../browser/dom.js'),
	]);
	using action = new Action('primary', '&Primary');
	using alternate = new Action('alternate', '&Alternate');
	Object.defineProperty(action, 'alt', { value: alternate });
	const runs: unknown[] = [];
	const context = { source: 'menu' };
	using runner = new (await import('../../common/actions.js')).ActionRunner();
	using willRunListener = runner.onWillRun(event => runs.push([event.action.id, event.context]));
	using menu = new Menu(dom.window.document.body, [action], { enableMnemonics: true, actionRunner: runner, context: context }, unthemedMenuStyles);
	try {
		const button = menu.getContainer().querySelector<HTMLButtonElement>('button')!;
		button.focus();
		action.label = '&Changed';
		action.checked = true;
		assert.equal(button.textContent, 'Changed');
		assert.equal(button.getAttribute('aria-checked'), 'true');
		assert.equal(button.getAttribute('aria-keyshortcuts'), 'c');
		assert.equal(dom.window.document.activeElement, button);
		dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Alt', altKey: true }));
		assert.equal(button.textContent, 'Alternate');
		assert.equal(button.getAttribute('role'), 'menuitem');
		assert.equal(button.getAttribute('aria-keyshortcuts'), 'a');
		button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
		dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Alt' }));
		assert.equal(button.textContent, 'Changed');
		assert.deepEqual(runs, [['alternate', context]]);
		alternate.enabled = false;
		button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, altKey: true }));
		assert.deepEqual(runs, [['alternate', context], ['primary', context]]);
	} finally {
		ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
		dom.window.close();
	}
});

test('Menu activates unique mnemonics and cycles duplicates at each submenu level', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(dom, ['Node']);
	const [{ SubmenuAction }, { Menu, unthemedMenuStyles }] = await Promise.all([
		import('../../common/actions.js'), import('../../browser/ui/menu/menu.js'),
	]);
	const runs: string[] = [];
	const action = (id: string, label: string): IAction => ({ id, label, tooltip: '', enabled: true, run: () => runs.push(id) });
	using menu = new Menu(dom.window.document.body, [action('one', '&Alpha'), action('two', '&Again'), new SubmenuAction('more', '&More', [action('child', '&Child')])], {
		enableMnemonics: true
	}, unthemedMenuStyles);
	try {
		const key = (target: Element, value: string): void => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true })); };
		key(menu.getContainer(), 'a');
		assert.equal(dom.window.document.activeElement?.textContent, 'Alpha');
		key(menu.getContainer(), 'a');
		assert.equal(dom.window.document.activeElement?.textContent, 'Again');
		assert.deepEqual(runs, []);
		key(menu.getContainer(), 'm');
		const child = dom.window.document.querySelector<HTMLButtonElement>('[data-action-id="child"] button')!;
		assert.equal(child.getAttribute('aria-keyshortcuts'), 'c');
		key(child, 'c');
		assert.deepEqual(runs, ['child']);
	} finally { dom.window.close(); }
});
