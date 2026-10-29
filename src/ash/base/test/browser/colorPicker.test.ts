import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Color } from '../../common/color.js';
import { toDisposable } from '../../common/lifecycle.js';

const environment = new JSDOM('<!doctype html><body></body>');
const document = environment.window.document;
suiteTeardown(() => environment.window.close());
const { ColorPicker } = await import('../../browser/ui/colorPicker/colorPicker.js');

function fixture() {
	let dismiss: ((commit: boolean) => void) | undefined;
	let panel: HTMLElement | undefined;
	let configurations = 0;
	let configurationDisposed = false;
	const picker = new ColorPicker(document, 'input', {
		color: 'Fill color',
		value: 'Fill hex',
		opacity: 'Fill opacity',
		popup: {
			show: (_anchor, content, onHide) => {
				panel = content;
				dismiss = onHide;
				document.body.append(content);
				return true;
			},
			hide: () => hide(false),
			configure: () => {
				configurations++;
				return toDisposable(() => {
					configurationDisposed = true;
				});
			},
		},
	});
	document.body.append(picker.domNode);
	function hide(commit: boolean) {
		const callback = dismiss;
		dismiss = undefined;
		panel?.remove();
		callback?.(commit);
	}
	return {
		picker,
		hide,
		get configurations() {
			return configurations;
		},
		get configurationDisposed() {
			return configurationDisposed;
		},
		get panel() {
			assert.ok(panel);
			return panel;
		},
		open() {
			picker.domNode.querySelector('button')!.click();
		},
		[Symbol.dispose]() {
			picker.dispose();
		},
	};
}

function field(root: HTMLElement, label: string): HTMLInputElement {
	const element = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
	assert.ok(element);
	return element;
}
function change(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new environment.window.Event('change', { bubbles: true }));
}
function hex(color: Color): string {
	return Color.Format.CSS.formatHexA(color, true);
}

test('ColorPicker input validates hex and opacity through the same color model', () => {
	using view = fixture();
	view.picker.setColor(Color.fromHex('#33669980'), 'fill');
	const commits: string[] = [];
	using subscription = view.picker.onDidCommitColor(color => commits.push(hex(color)));
	change(field(view.picker.domNode, 'Fill hex'), 'abc');
	assert.equal(field(view.picker.domNode, 'Fill hex').value, 'AABBCC');
	assert.equal(hex(view.picker.color), '#aabbcc80');
	change(field(view.picker.domNode, 'Fill opacity'), '40');
	assert.equal(hex(view.picker.color), '#aabbcc66');
	change(field(view.picker.domNode, 'Fill hex'), '12345678');
	assert.equal(hex(view.picker.color), '#12345678');
	change(field(view.picker.domNode, 'Fill opacity'), '101');
	assert.equal(field(view.picker.domNode, 'Fill opacity').getAttribute('aria-invalid'), 'true');
	change(field(view.picker.domNode, 'Fill hex'), 'xyz');
	assert.equal(field(view.picker.domNode, 'Fill hex').getAttribute('aria-invalid'), 'true');
	assert.deepEqual(commits, ['#aabbcc80', '#aabbcc66', '#12345678']);
	assert.equal(view.configurations, 0);
});

test('ColorPicker creates its popup once and keeps compact hex independent of panel format', () => {
	const view = fixture();
	try {
		view.picker.setColor(Color.fromHex('#336699'), 'fill');
		view.open();
		assert.equal(ColorPicker.getFocused(field(view.panel, 'Color value')), view.picker);
		assert.equal(ColorPicker.getFocused(field(view.picker.domNode, 'Fill hex')), view.picker);
		const format = view.panel.querySelector('select')!;
		format.value = 'rgb';
		format.dispatchEvent(new environment.window.Event('change'));
		change(field(view.panel, 'RGB R'), '255');
		assert.equal(field(view.picker.domNode, 'Fill hex').value, 'FF6699');
		view.hide(false);
		view.open();
		assert.equal(view.configurations, 1);
	} finally {
		view[Symbol.dispose]();
	}
	assert.equal(view.configurationDisposed, true);
});

test('ColorPicker opacity fields and slider preserve exact RGB channels', () => {
	using view = fixture();
	view.picker.setColor(Color.fromHex('#2f6fed'));
	change(field(view.picker.domNode, 'Fill opacity'), '40');
	assert.equal(hex(view.picker.color), '#2f6fed66');
	view.open();
	change(field(view.panel, 'Opacity (%)'), '60');
	assert.equal(hex(view.picker.color), '#2f6fed99');
	const slider = field(view.panel, 'Opacity');
	slider.value = '40';
	slider.dispatchEvent(new environment.window.Event('input'));
	assert.equal(hex(view.picker.color), '#2f6fed66');
});

test('ColorPicker keeps live document echoes and same-target Undo inside its popup', () => {
	using view = fixture();
	view.picker.setColor(Color.fromHex('#2f6fed'), 'fill');
	using echo = view.picker.onDidChangeColor(color => view.picker.setColor(color, 'fill'));
	view.open();
	const alpha = field(view.panel, 'Opacity');
	alpha.value = '40';
	alpha.dispatchEvent(new environment.window.Event('input'));
	assert.equal(view.panel.isConnected, true);
	assert.equal(hex(view.picker.color), '#2f6fed66');
	view.picker.setColor(Color.fromHex('#12345680'), 'fill');
	assert.equal(view.panel.isConnected, true);
	assert.equal(field(view.panel, 'Color value').value, '123456');
	assert.equal(field(view.picker.domNode, 'Fill opacity').value, '50.2');
	view.picker.setColor(Color.fromHex('#12345680'), 'other fill');
	assert.equal(view.panel.isConnected, false);
});

test('ColorPicker commits an explicit equal-value input once so a host can override inheritance', () => {
	using view = fixture();
	view.picker.setColor(Color.fromHex('#123456'));
	let commits = 0;
	using subscription = view.picker.onDidCommitColor(() => {
		commits++;
	});
	const input = field(view.picker.domNode, 'Fill hex');
	input.dispatchEvent(new environment.window.Event('input'));
	change(input, '123456');
	change(input, '123456');
	assert.equal(commits, 1);
});

test('ColorPicker preserves incomplete input through unchanged model refreshes and Escape restores it', () => {
	using view = fixture();
	view.picker.setColor(Color.fromHex('#123456'), 'fill');
	const input = field(view.picker.domNode, 'Fill hex');
	change(input, 'invalid');
	view.picker.setColor(Color.fromHex('#123456'), 'fill');
	assert.equal(input.value, 'invalid');
	assert.equal(input.getAttribute('aria-invalid'), 'true');
	input.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(input.value, '123456');
	assert.equal(input.hasAttribute('aria-invalid'), false);
});

test('ColorPicker rolls back popup previews on cancellation and commits outside dismissal', () => {
	using view = fixture();
	view.picker.setColor(Color.fromHex('#336699'), 'fill');
	const commits: string[] = [];
	using subscription = view.picker.onDidCommitColor(color => commits.push(hex(color)));
	view.open();
	const alpha = field(view.panel, 'Opacity');
	alpha.value = '40';
	alpha.dispatchEvent(new environment.window.Event('input'));
	assert.equal(field(view.picker.domNode, 'Fill opacity').value, '40');
	view.hide(false);
	assert.equal(hex(view.picker.color), '#336699');
	view.open();
	alpha.value = '40';
	alpha.dispatchEvent(new environment.window.Event('input'));
	view.hide(true);
	assert.deepEqual(commits, ['#33669966']);
	view.open();
	view.picker.setColor(Color.fromHex('#123456'), 'other fill');
	assert.equal(view.panel.isConnected, false);
	assert.equal(hex(view.picker.color), '#123456');
});

test('ColorPicker dialog and embedded presentations retain their commit and close contracts', () => {
	for (const variant of ['dialog', 'embedded'] as const) {
		using picker = new ColorPicker(document, variant);
		picker.setColor(Color.fromHex('#12345680'));
		let committed: string | undefined;
		using subscription = picker.onDidCommitColor(color => {
			committed = hex(color);
		});
		change(field(picker.domNode, 'Opacity (%)'), '40');
		assert.equal(committed, '#12345666');
		assert.equal(picker.domNode.getAttribute('role'), variant === 'dialog' ? 'dialog' : 'group');
		if (variant === 'dialog') {
			let closed = false;
			using close = picker.onDidRequestClose(() => {
				closed = true;
			});
			picker.domNode.querySelector('button')!.click();
			assert.equal(closed, true);
		}
	}
});
