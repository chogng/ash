import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../common/actions.js';
import { Separator } from '../../common/actions.js';
import { Lxicon } from '../../common/lxicons.js';
import { ActionBar } from '../../browser/ui/actionbar/actionbar.js';
import { ButtonActionViewItem, LabelActionViewItem } from '../../browser/ui/actionbar/actionViewItems.js';
import { setHoverDelegate, type HoverDelegateSetupOptions, type IManagedHover } from '../../browser/ui/hover/hoverDelegate.js';
import { AnchorPosition } from '../../common/layout.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';
import type { IContextMenuDelegate } from '../../browser/contextmenu.js';
import { DropdownMenuActionViewItem } from '../../browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { addDisposableListener } from '../../browser/dom.js';

suite('ActionBar open dropdown updates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const method of ['setActions', 'updateActions'] as const) {
		test(`${method} preserves an open menu and applies only the latest actions after dismissal`, async () => {
			const dom = new JSDOM('<!doctype html><body></body>');
			try {
				let menu: IContextMenuDelegate | undefined;
				using bar = new ActionBar(dom.window.document.body, {
					actions: [action('menu'), action('before')],
					actionViewItemProvider: item => item.id === 'menu' ? new DropdownMenuActionViewItem(item, [action('choice')], {
						showContextMenu(options) { menu = options; },
					}) : undefined,
				});
				const trigger = bar.element.querySelector<HTMLButtonElement>('[data-action-id="menu"] button')!;
				trigger.focus();
				trigger.click();
				assert.ok(menu);
				const opened = menu;
				bar[method]([action('menu'), action('intermediate')]);
				bar[method]([{ ...action('menu'), label: 'Updated menu' }, action('latest')]);
				assert.equal(trigger.isConnected, true);
				assert.equal(opened.cancellationToken?.isCancellationRequested, false);
				assert.equal(trigger.getAttribute('aria-expanded'), 'true');
				assert.equal(bar.element.textContent, 'menubefore');
				opened.onHide?.(true);
				await Promise.resolve();
				const updatedTrigger = bar.element.querySelector<HTMLButtonElement>('[data-action-id="menu"] button')!;
				assert.notEqual(updatedTrigger, trigger);
				assert.equal(bar.element.textContent, 'Updated menulatest');
				assert.equal(updatedTrigger.getAttribute('aria-expanded'), 'false');
				assert.equal(dom.window.document.activeElement, updatedTrigger);

				updatedTrigger.click();
				const finalMenu = menu!;
				bar[method]([action('menu'), action('discarded')]);
				bar.dispose();
				assert.equal(finalMenu.cancellationToken?.isCancellationRequested, true);
				finalMenu.onHide?.(true);
				await Promise.resolve();
				assert.equal(bar.element.isConnected, false);
				assert.equal(bar.element.textContent, '');
			} finally {
				dom.window.close();
			}
		});
	}

	test('a reopened menu retains pending actions until its own dismissal', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			let menu: IContextMenuDelegate | undefined;
			using bar = new ActionBar(dom.window.document.body, {
				actions: [action('menu')],
				actionViewItemProvider: item => new DropdownMenuActionViewItem(item, [action('choice')], {
					showContextMenu(options) { menu = options; },
				}),
			});
			const trigger = bar.element.querySelector<HTMLButtonElement>('button')!;
			trigger.click();
			bar.setActions([{ ...action('menu'), label: 'Updated menu' }]);
			menu!.onHide?.(true);
			trigger.click();
			await Promise.resolve();
			assert.equal(trigger.isConnected, true);
			assert.equal(menu!.cancellationToken?.isCancellationRequested, false);
			menu!.onHide?.(true);
			await Promise.resolve();
			assert.equal(bar.element.textContent, 'Updated menu');
		} finally {
			dom.window.close();
		}
	});

	test('a synchronous provider dismissal finishes before queued actions replace its trigger', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			let trigger: HTMLButtonElement;
			using bar = new ActionBar(dom.window.document.body, {
				actions: [action('menu')],
				actionViewItemProvider: item => new DropdownMenuActionViewItem(item, [action('choice')], {
					showContextMenu(options) {
						bar.updateActions([{ ...action('menu'), label: 'Updated menu' }]);
						options.onHide?.(true);
						assert.equal(trigger.isConnected, true);
					},
				}),
			});
			trigger = bar.element.querySelector<HTMLButtonElement>('button')!;
			trigger.click();
			await Promise.resolve();
			assert.equal(trigger.isConnected, false);
			assert.equal(bar.element.textContent, 'Updated menu');
		} finally {
			dom.window.close();
		}
	});

	test('switching dropdowns keeps the next trigger alive from pointerdown through click', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			let menu: IContextMenuDelegate | undefined;
			using bar = new ActionBar(dom.window.document.body, {
				actions: [action('first'), action('second')],
				actionViewItemProvider: item => new DropdownMenuActionViewItem(item, [action(item.id + '.choice')], {
					showContextMenu(options) { menu = options; },
				}),
			});
			const [first, second] = [...bar.element.querySelectorAll('button')];
			const icon = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			second!.append(icon);
			first!.click();
			bar.setActions([{ ...action('first'), label: 'Updated first' }, action('second')]);
			// Match the context view's capture-phase outside-pointer dismissal.
			using dismissal = addDisposableListener(dom.window.document, 'pointerdown', () => menu!.onHide?.(true), true);
			icon.dispatchEvent(pointerEvent(dom.window, 'pointerdown'));
			await Promise.resolve();
			assert.equal(second!.isConnected, true);
			icon.dispatchEvent(pointerEvent(dom.window, 'pointerup'));
			await Promise.resolve();
			assert.equal(second!.isConnected, true);
			second!.click();
			await Promise.resolve();
			assert.deepEqual(menu!.getActions().map(item => item.id), ['second.choice']);
			assert.equal(menu!.cancellationToken?.isCancellationRequested, false);
			assert.equal(second!.getAttribute('aria-expanded'), 'true');
			menu!.onHide?.(true);
			await Promise.resolve();
			assert.equal(bar.element.textContent, 'Updated firstsecond');
		} finally {
			dom.window.close();
		}
	});

	for (const end of ['pointercancel', 'outside pointerup', 'window blur'] as const) {
		test(`${end} releases a pending pointer activation without a click`, async () => {
			const dom = new JSDOM('<!doctype html><body></body>');
			try {
				using bar = new ActionBar(dom.window.document.body, { actions: [action('first')] });
				const trigger = bar.element.querySelector('button')!;
				trigger.dispatchEvent(pointerEvent(dom.window, 'pointerdown'));
				bar.setActions([{ ...action('first'), label: 'Updated first' }]);
				await Promise.resolve();
				assert.equal(trigger.isConnected, true);
				if (end === 'window blur') dom.window.dispatchEvent(new dom.window.Event('blur'));
				else dom.window.document.body.dispatchEvent(pointerEvent(dom.window, end === 'pointercancel' ? 'pointercancel' : 'pointerup'));
				await Promise.resolve();
				assert.equal(bar.element.textContent, 'Updated first');
			} finally {
				dom.window.close();
			}
		});
	}

	test('a consumed click releases pending updates at the end of the native click task', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			let timeout: (() => void) | undefined;
			dom.window.setTimeout = ((callback: () => void) => { timeout = callback; return 1; }) as typeof dom.window.setTimeout;
			dom.window.clearTimeout = () => { timeout = undefined; };
			using bar = new ActionBar(dom.window.document.body, { actions: [action('first')] });
			const trigger = bar.element.querySelector('button')!;
			using consumed = addDisposableListener(trigger, 'click', event => event.stopImmediatePropagation(), true);
			trigger.dispatchEvent(pointerEvent(dom.window, 'pointerdown'));
			bar.setActions([{ ...action('first'), label: 'Updated first' }]);
			trigger.dispatchEvent(pointerEvent(dom.window, 'pointerup'));
			trigger.click();
			await Promise.resolve();
			assert.equal(trigger.isConnected, true);
			assert.ok(timeout);
			timeout();
			await Promise.resolve();
			assert.equal(bar.element.textContent, 'Updated first');
			assert.equal(timeout, undefined);
		} finally {
			dom.window.close();
		}
	});
});

function pointerEvent(window: JSDOM['window'], type: string): Event {
	const event = new window.MouseEvent(type, { bubbles: true, button: 0 });
	Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 } });
	return event;
}

suite('ActionBar updated focus availability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('disabling a focused action transfers the tab stop and focus to an enabled action', () => {
		const dom = new JSDOM('<!doctype html><body><input></body>');
		try {
			const first = action('first');
			using bar = new ActionBar(dom.window.document.body, { actions: [first, action('second')] });
			bar.element.querySelector<HTMLButtonElement>('[data-action-id="second"] button')!.focus();
			bar.updateActions([first, action('second', false)]);
			const firstButton = bar.element.querySelector<HTMLButtonElement>('[data-action-id="first"] button')!;
			assert.equal(firstButton.tabIndex, 0);
			assert.equal(dom.window.document.activeElement, firstButton);
			bar.updateActions([action('first', false), action('second', false)]);
			assert.ok([...bar.element.querySelectorAll('button')].every(button => button.tabIndex === -1));
			const input = dom.window.document.querySelector('input')!;
			input.focus();
			bar.updateActions([action('first', false), action('second')]);
			assert.equal(bar.element.querySelector<HTMLButtonElement>('[data-action-id="second"] button')!.tabIndex, 0);
			assert.equal(dom.window.document.activeElement, input);
		} finally {
			dom.window.close();
		}
	});
});

test('ActionViewItem shares hover delay within its ActionBar and isolates other toolbars', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const setups: HoverDelegateSetupOptions[] = [];
	using delegateRegistration = setHoverDelegate({
		setupDelayedHover() { throw new Error('Unexpected delayed hover registration'); },
		setupHover(options) {
			setups.push(options);
			options.target.removeAttribute('title');
			return managedHover();
		},
	});
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action('open')],
		actionViewItemOptions: { hoverAnchorPosition: AnchorPosition.Below },
	});
	dom.window.document.body.append(actionBar.element);

	const button = actionBar.element.querySelector('button');
	assert.ok(button);
	assert.equal(setups.length, 1);
	assert.equal(setups[0]?.target, button);
	assert.equal(setups[0]?.content, 'open');
	assert.ok(setups[0]?.groupId);
	assert.equal(setups[0]?.anchorPosition, AnchorPosition.Below);
	assert.equal(button.hasAttribute('title'), false);
	actionBar.add(action('close'));
	assert.equal(setups[1]?.groupId, setups[0]?.groupId);
	using otherBar = new ActionBar(dom.window.document.body, { actions: [action('chat')] });
	assert.notEqual(setups[2]?.groupId, setups[0]?.groupId);
	using customBar = new ActionBar(dom.window.document.body, {
		actions: [action('custom-first'), action('custom-second')],
		actionViewItemProvider: entry => new ButtonActionViewItem(entry),
	});
	assert.ok(setups[3]?.groupId);
	assert.equal(setups[3]?.groupId, setups[4]?.groupId, 'The host also groups providers that omit constructor options');
	assert.notEqual(setups[3]?.groupId, setups[0]?.groupId);

	dom.window.close();
});

test('LabelActionViewItem owns compact icon-and-text action markup', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	let runCount = 0;
	const activeAction: IAction = {
		id: 'active-terminal',
		label: 'Focus Active Terminal',
		tooltip: 'Focus Active Terminal',
		enabled: true,
		run: () => runCount++,
	};
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [activeAction],
		actionViewItemProvider: (action) => new LabelActionViewItem(action, {
			label: 'cmd',
			icon: Lxicon.terminalCmd,
			ariaLabel: 'Active terminal: cmd',
			tooltip: 'Active terminal: cmd',
		}),
	});
	dom.window.document.body.append(actionBar.element);

	const label = actionBar.element.querySelector<HTMLButtonElement>('.ash-action-label');
	assert.ok(label);
	assert.equal(label.classList.contains('ash-button'), false);
	assert.equal(label.querySelector('.ash-action-label-text')?.textContent, 'cmd');
	assert.ok(label.querySelector('.ash-action-label-icon > .ash-icon'));
	assert.equal(label.getAttribute('aria-label'), 'Active terminal: cmd');
	assert.equal(label.tabIndex, 0);
	label.click();
	assert.equal(runCount, 1);

	dom.window.close();
});

test('ActionBar enables native drag sources only when its view item opts in', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action('drag-source'), action('ordinary')],
		actionViewItemProvider: (item) => new LabelActionViewItem(item, {
			draggable: item.id === 'drag-source',
		}),
	});
	dom.window.document.body.append(actionBar.element);

	const [source, ordinary] = actionBar.element.querySelectorAll<HTMLElement>('.ash-action-view-item');
	assert.ok(source);
	assert.ok(ordinary);
	assert.equal(source.draggable, true);
	assert.equal(source.classList.contains('ash-dnd-draggable'), true);
	assert.equal(ordinary.draggable, false);
	assert.equal(ordinary.classList.contains('ash-dnd-draggable'), false);

	dom.window.close();
});

test('ActionBar reports drop targets without enabling ordinary toolbars', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const dropped: Array<{ target: string | undefined; position: string; }> = [];
	let dragging = false;
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action('first'), action('second')],
		actionViewItemProvider: (item) => new LabelActionViewItem(item, { draggable: true }),
		dragAndDrop: {
			canDrop: () => dragging,
			onDragStart: () => {
				dragging = true;
			},
			onDrop: (target, position) => dropped.push({ target: target?.id, position }),
			onDragEnd: () => {
				dragging = false;
			},
		},
	});
	dom.window.document.body.append(actionBar.element);
	assert.equal(actionBar.element.classList.contains('ash-action-bar-dnd'), true);
	const [first, second] = actionBar.element.querySelectorAll<HTMLElement>('.ash-action-view-item');
	assert.ok(first);
	assert.ok(second);
	Object.defineProperty(second, 'getBoundingClientRect', {
		value: () => ({ left: 100, width: 100 }),
	});

	first.dispatchEvent(dragEvent(dom.window, 'dragstart'));
	second.dispatchEvent(dragEvent(dom.window, 'dragover', 175));
	assert.equal(second.classList.contains('ash-dnd-drop-after'), true);
	second.dispatchEvent(dragEvent(dom.window, 'drop', 175));

	assert.deepEqual(dropped, [{ target: 'second', position: 'after' }]);
	assert.equal(dragging, false);
	dom.window.close();
});

test('ActionBar keeps insertion feedback continuous across gaps and hides no-op drops', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const dropped: string[] = [];
	let dragging = false;
	using actionBar = new ActionBar(dom.window.document.body, {
		actions: [action('first'), action('second'), action('third')],
		actionViewItemProvider: (item) => new LabelActionViewItem(item, { draggable: true }),
		dragAndDrop: {
			canDrop: () => dragging,
			onDragStart: () => {
				dragging = true;
			},
			onDrop: (target, position) => dropped.push(`${target?.id}:${position}`),
			onDragEnd: () => {
				dragging = false;
			},
		},
	});
	dom.window.document.body.append(actionBar.element);
	const [first, second, third] = actionBar.element.querySelectorAll<HTMLElement>('.ash-action-view-item');
	assert.ok(first);
	assert.ok(second);
	assert.ok(third);
	first.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect);
	second.getBoundingClientRect = () => ({ left: 104, width: 100 } as DOMRect);
	third.getBoundingClientRect = () => ({ left: 208, width: 100 } as DOMRect);

	third.dispatchEvent(dragEvent(dom.window, 'dragstart'));
	actionBar.element.dispatchEvent(dragEvent(dom.window, 'dragover', 102));
	assert.equal(second.classList.contains('ash-dnd-drop-before'), true);
	actionBar.element.dispatchEvent(dragEvent(dom.window, 'drop', 102));
	assert.deepEqual(dropped, ['second:before']);

	first.dispatchEvent(dragEvent(dom.window, 'dragstart'));
	const dataTransfer = testDataTransfer();
	second.dispatchEvent(dragEvent(dom.window, 'dragover', 125, dataTransfer));
	assert.equal(second.classList.contains('ash-dnd-drop-before'), false);
	assert.equal(dataTransfer.dropEffect, 'move');
	second.dispatchEvent(dragEvent(dom.window, 'drop', 125));
	assert.deepEqual(dropped, ['second:before']);
	assert.equal(dragging, false);
	dom.window.close();
});

test('ActionBar owns horizontal keyboard navigation', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const actionBar = new ActionBar(dom.window.document.body, {
		actions: [
			action('first'),
			new Separator(),
			action('disabled', false),
			action('last'),
		],
	});
	dom.window.document.body.append(actionBar.element);
	const buttons = actionBar.element.querySelectorAll('button');
	const first = buttons[0];
	const disabled = buttons[1];
	const last = buttons[2];
	assert.ok(first);
	assert.ok(disabled);
	assert.ok(last);
	assert.equal(actionBar.element.getAttribute('role'), 'toolbar');
	assert.equal(actionBar.element.getAttribute('aria-orientation'), 'horizontal');
	assert.deepEqual(
		[...buttons].map((button) => button.tabIndex),
		[0, -1, -1],
	);

	first.focus();
	first.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight'));
	assert.equal(dom.window.document.activeElement, last);
	assert.deepEqual(
		[...buttons].map((button) => button.tabIndex),
		[-1, -1, 0],
	);
	last.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight'));
	assert.equal(dom.window.document.activeElement, first);
	first.dispatchEvent(keyboardEvent(dom.window, 'ArrowLeft'));
	assert.equal(dom.window.document.activeElement, last);
	last.dispatchEvent(keyboardEvent(dom.window, 'Home'));
	assert.equal(dom.window.document.activeElement, first);
	first.dispatchEvent(keyboardEvent(dom.window, 'End'));
	assert.equal(dom.window.document.activeElement, last);

	actionBar.dispose();
	dom.window.close();
});

test('ActionBar maps vertical navigation to up and down', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const actionBar = new ActionBar(dom.window.document.body, {
		actions: [action('first'), action('second')],
		orientation: 'vertical',
	});
	dom.window.document.body.append(actionBar.element);
	const buttons = actionBar.element.querySelectorAll('button');
	const first = buttons[0];
	const second = buttons[1];
	assert.ok(first);
	assert.ok(second);
	assert.equal(actionBar.element.getAttribute('role'), 'toolbar');
	assert.equal(actionBar.element.getAttribute('aria-orientation'), 'vertical');

	first.focus();
	first.dispatchEvent(keyboardEvent(dom.window, 'ArrowDown'));
	assert.equal(dom.window.document.activeElement, second);
	second.dispatchEvent(keyboardEvent(dom.window, 'ArrowUp'));
	assert.equal(dom.window.document.activeElement, first);
	first.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight'));
	assert.equal(dom.window.document.activeElement, first);
	actionBar.setOrientation('horizontal');
	assert.equal(actionBar.element.getAttribute('aria-orientation'), 'horizontal');
	assert.equal(actionBar.element.classList.contains('horizontal'), true);
	first.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight'));
	assert.equal(dom.window.document.activeElement, second);

	actionBar.dispose();
	dom.window.close();
});

test('ActionBar retains focus when an action view item is updated', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const actionBar = new ActionBar(dom.window.document.body, {
		actions: [action('first'), action('second')],
	});
	const second = actionBar.element.querySelector<HTMLButtonElement>('[data-action-id="second"] button');
	assert.ok(second);
	second.focus();
	actionBar.updateActions([action('first'), action('second')]);
	const replacement = actionBar.element.querySelector<HTMLButtonElement>('[data-action-id="second"] button');
	assert.ok(replacement);
	assert.notEqual(replacement, second);
	assert.equal(dom.window.document.activeElement, replacement);
	actionBar.setActions([action('first'), action('second'), action('third')]);
	const afterStructuralChange = actionBar.element.querySelector<HTMLButtonElement>('[data-action-id="second"] button');
	assert.ok(afterStructuralChange);
	assert.equal(dom.window.document.activeElement, afterStructuralChange);
	actionBar.dispose();
	dom.window.close();
});

function action(
	id: string,
	enabled = true,
): IAction {
	return {
		id,
		label: id,
		tooltip: id,
		enabled,
		run() { },
	};
}

function keyboardEvent(
	targetWindow: { readonly KeyboardEvent: typeof KeyboardEvent; },
	key: string,
): KeyboardEvent {
	return new targetWindow.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		key,
	});
}

function dragEvent(targetWindow: { readonly Event: typeof Event; }, type: string, clientX = 0, dataTransfer?: DataTransfer): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, 'clientX', { value: clientX });
	if (dataTransfer) Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
	return event;
}

function testDataTransfer(): DataTransfer {
	return { dropEffect: 'none', effectAllowed: 'none', setData() { } } as unknown as DataTransfer;
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
