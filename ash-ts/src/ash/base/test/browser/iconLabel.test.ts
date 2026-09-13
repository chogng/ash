import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { IconLabel } from '../../browser/ui/iconlabel/iconlabel.js';
import { SimpleIconLabel } from '../../browser/ui/iconlabel/simpleIconLabel.js';
import { h } from '../../browser/dom.js';
import { register } from '../../common/icon.js';
import { setHoverDelegate, type IManagedHover } from '../../browser/ui/hover/hoverDelegate.js';

test('IconLabel updates name, description, suffix, and semantic icons in place', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const icon = register('test-icon-label-inline', () => '<svg viewBox="0 0 16 16"></svg>');
	const hoverContents: unknown[] = [];
	using delegate = setHoverDelegate({
		setupHover(options) {
			hoverContents.push(options.content);
			return managedHover();
		},
	});
	using label = new IconLabel(dom.window.document.body, {
		label: '$(test-icon-label-inline) file.ts',
		icon,
		description: 'src',
		suffix: ':3',
		supportIcons: true,
		title: 'Full path',
	});

	assert.equal(label.element.querySelectorAll('.ash-icon').length, 2);
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'src');
	assert.equal(label.element.querySelector('.ash-icon-label-suffix')?.textContent, ':3');
	assert.deepEqual(hoverContents, ['Full path']);

	label.element.classList.add('consumer-class');
	label.setLabel('renamed.ts');
	assert.equal(label.element.textContent, 'renamed.ts');
	assert.equal(label.element.querySelectorAll('.ash-icon').length, 0);
	assert.equal(label.element.classList.contains('consumer-class'), true);
	assert.equal(label.element.querySelector<HTMLElement>('.ash-icon-label-description')?.hidden, true);

	dom.window.close();
});

test('IconLabel escapes newlines, maps highlights, and exposes compatibility metadata', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using label = new IconLabel(dom.window.document.body, {
		label: 'first\nsecond',
		domId: 'label-id',
		labelEscapeNewLines: true,
		matches: [{ start: 6, end: 12 }],
		disabledCommand: true,
	});

	assert.equal(label.labelElement.id, 'label-id');
	assert.equal(label.labelElement.textContent, 'first↵second');
	assert.equal(label.labelElement.querySelector('.ash-icon-label-highlight')?.textContent, 'second');
	assert.equal(label.labelElement.parentElement?.classList.contains('disabled'), true);

	dom.window.close();
});

test('IconLabel renders unknown inline icons as literal text', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using label = new IconLabel(dom.window.document.body, {
		label: '$(not-registered) file.ts',
		supportIcons: true,
	});
	assert.equal(label.labelElement.textContent, '$(not-registered) file.ts');
	dom.window.close();
});

test('SimpleIconLabel renders semantic icons and owns its hover', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const icon = register('test-simple-icon-label', () => '<svg viewBox="0 0 16 16"></svg>');
	const container = h(dom.window.document, 'span');
	dom.window.document.body.append(container);
	using label = new SimpleIconLabel(container);
	label.text = `$(test-simple-icon-label) ready`;
	assert.equal(container.querySelectorAll('.ash-icon').length, 1);
	label.text = 'done';
	assert.equal(container.textContent, 'done');
	label.title = 'Done';
	label.title = '';
	dom.window.close();
});

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
	};
}
