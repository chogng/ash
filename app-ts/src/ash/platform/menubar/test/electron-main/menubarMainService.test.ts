import assert from 'node:assert/strict';
import { test } from 'mocha';
import { NativeMenubarMainService, type INativeMenubarMainHost, type INativeMenubarMainMenuItem, type INativeMenubarMainWindow } from '../../../../platform/menubar/electron-main/menubarMainService.js';
import type { INativeMenubarData } from '../../../../platform/menubar/common/nativeMenubar.js';

test('application menubar follows workbench focus and survives individual window disposal', () => {
	const host = new TestMenubarHost();
	using service = new NativeMenubarMainService(host);
	const first = new TestBrowserWindow(1);
	const second = new TestBrowserWindow(2);
	using firstRegistration = service.registerWindow(first.value);
	using secondRegistration = service.registerWindow(second.value);

	first.setFocused(true);
	service.update(first.value, menuData(1, 'First action', 'first', 'first-alt'));
	second.setFocused(true);
	first.setFocused(false);
	service.update(second.value, menuData(1, 'Second action', 'second'));

	first.setFocused(true);
	second.setFocused(false);
	first.fireFocus();
	invokeAction(host.template, 'First action', false);
	assert.deepEqual(first.selections, [{ revision: 1, id: 'first' }]);
	assert.deepEqual(second.selections, []);

	second.setFocused(true);
	first.setFocused(false);
	second.fireFocus();
	invokeAction(host.template, 'Second action', false);
	assert.deepEqual(second.selections, [{ revision: 1, id: 'second' }]);

	firstRegistration.dispose();
	assert.ok(host.template);
	invokeAction(host.template, 'Second action', false);
	assert.deepEqual(second.selections, [
		{ revision: 1, id: 'second' },
		{ revision: 1, id: 'second' },
	]);
});

test('application menubar selects an alternative action while Option is held', () => {
	const host = new TestMenubarHost();
	using service = new NativeMenubarMainService(host);
	const window = new TestBrowserWindow(1);
	window.setFocused(true);
	using registration = service.registerWindow(window.value);
	service.update(window.value, menuData(4, 'Save', 'save', 'save-as'));

	invokeAction(host.template, 'Save', true);

	assert.deepEqual(window.selections, [{ revision: 4, id: 'save-as' }]);
});

class TestMenubarHost implements INativeMenubarMainHost {
	readonly applicationName = 'Ash';
	template: readonly INativeMenubarMainMenuItem[] | undefined;

	setApplicationMenu(template: readonly INativeMenubarMainMenuItem[] | undefined): void {
		this.template = template;
	}
}

class TestBrowserWindow {
	private readonly focusListeners = new Set<() => void>();
	private focused = false;
	private destroyed = false;
	readonly selections: Array<{ readonly revision: number; readonly id: string }> = [];
	readonly value: INativeMenubarMainWindow;

	constructor(id: number) {
		this.value = {
			id,
			isDestroyed: () => this.destroyed,
			isFocused: () => this.focused,
			on: (event: string, listener: () => void) => {
				if (event === 'focus') this.focusListeners.add(listener);
				return this.value;
			},
			removeListener: (event: string, listener: () => void) => {
				if (event === 'focus') this.focusListeners.delete(listener);
				return this.value;
			},
			webContents: {
				send: (_channel: string, selection: { readonly revision: number; readonly id: string }) => {
					this.selections.push(selection);
				},
			},
		} as INativeMenubarMainWindow;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	fireFocus(): void {
		for (const listener of this.focusListeners) listener();
	}
}

function menuData(revision: number, label: string, id: string, altId?: string): INativeMenubarData {
	return {
		revision,
		menus: [{
			label: 'File',
			items: [{ type: 'action', id, ...(altId ? { altId } : {}), label, enabled: true }],
		}],
	};
}

function invokeAction(
	template: readonly INativeMenubarMainMenuItem[] | undefined,
	label: string,
	altKey: boolean,
): void {
	assert.ok(template);
	const fileMenu = template.find(item => item.label === 'File');
	assert.ok(fileMenu && Array.isArray(fileMenu.submenu));
	const action = fileMenu.submenu.find(item => item.label === label);
	assert.ok(action?.click);
	Reflect.apply(action.click, undefined, [undefined, undefined, { altKey }]);
}
