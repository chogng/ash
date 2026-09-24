import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../browser/dom.js';
import { createFastDomNode, FastDomNode } from '../../browser/fastDomNode.js';

test('FastDomNode exposes the retained-style contract used by browser components', () => {
	const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
	const element = dom.window.document.querySelector<HTMLDivElement>('#root')!;
	const node = createFastDomNode(element);

	node.setMaxWidth(400);
	node.setWidth(320);
	node.setHeight(200);
	node.setTop(10);
	node.setLeft(20);
	node.setBottom('5%');
	node.setRight('2rem');
	node.setPaddingTop(1);
	node.setPaddingLeft(2);
	node.setPaddingBottom(3);
	node.setPaddingRight(4);
	node.setFontFamily('monospace');
	node.setFontWeight('600');
	node.setFontSize(14);
	node.setFontStyle('italic');
	node.setFontFeatureSettings('"liga"');
	node.setFontVariationSettings('"wght" 600');
	node.setTextDecoration('underline');
	node.setLineHeight(20);
	node.setLetterSpacing(1);
	node.setClassName('retained');
	node.toggleClassName('active');
	node.setDisplay('block');
	node.setPosition('absolute');
	node.setVisibility('visible');
	node.setColor('red');
	node.setBackgroundColor('blue');
	node.setLayerHinting(true);
	node.setTransform('translate3d(1px, 2px, 0)');
	node.setContain('layout');
	node.setBoxShadow('1px 0 red inset');
	node.setAttribute('data-owner', 'test');

	assert.equal(element.style.maxWidth, '400px');
	assert.equal(element.style.width, '320px');
	assert.equal(element.style.height, '200px');
	assert.equal(element.style.top, '10px');
	assert.equal(element.style.left, '20px');
	assert.equal(element.style.padding, '1px 4px 3px 2px');
	assert.equal(element.style.fontFamily, 'monospace');
	assert.equal(element.style.fontSize, '14px');
	assert.equal(element.style.transform, 'translate3d(1px, 2px, 0)');
	assert.equal(element.style.contain, 'layout');
	assert.equal(element.className, 'retained active');
	assert.equal(element.dataset.owner, 'test');

	node.removeAttribute('data-owner');
	assert.equal(element.hasAttribute('data-owner'), false);
	const child = createFastDomNode(h(dom.window.document, 'div'));
	node.appendChild(child);
	assert.equal(element.firstElementChild, child.domNode);
	node.removeChild(child);
	assert.equal(element.childElementCount, 0);
	element.tabIndex = -1;
	node.focus();
	assert.equal(dom.window.document.activeElement, element);
	dom.window.close();
});

test('FastDomNode owns its cached properties from wrapper construction', () => {
	const fixture = createWriteFixture();
	fixture.values.width = '24px';
	fixture.values.transform = 'translateX(1px)';
	fixture.values.className = 'retained';
	const node = new FastDomNode(fixture.element);

	node.setWidth(24);
	node.setWidth('24px');
	node.setTransform('translateX(1px)');
	node.setTransform('translateX(1px)');
	node.setClassName('retained');
	node.setClassName('retained');

	assert.deepEqual(fixture.writes, { width: 1, transform: 1, className: 1 });

	node.toggleClassName('active');
	node.toggleClassName('active');
	assert.equal(fixture.values.className, 'retained');
	assert.equal(fixture.writes.className, 3);
});

test('Layer hinting and explicit transforms share one cache', () => {
	const fixture = createWriteFixture();
	const node = new FastDomNode(fixture.element);

	node.setLayerHinting(true);
	node.setTransform('translate3d(0px, 0px, 0px)');
	node.setLayerHinting(false);
	node.setTransform('');

	assert.equal(fixture.values.transform, '');
	assert.equal(fixture.writes.transform, 2);
});

function createWriteFixture(): {
	readonly element: HTMLElement;
	readonly values: { width: string; transform: string; className: string };
	readonly writes: { width: number; transform: number; className: number };
} {
	const values = { width: '', transform: '', className: '' };
	const writes = { width: 0, transform: 0, className: 0 };
	const style = {} as CSSStyleDeclaration;
	for (const property of ['width', 'transform'] as const) {
		Object.defineProperty(style, property, {
			get: () => values[property],
			set: (value: string) => {
				values[property] = value;
				writes[property] += 1;
			},
		});
	}
	const element = { style } as HTMLElement;
	Object.defineProperty(element, 'className', {
		get: () => values.className,
		set: (value: string) => {
			values.className = value;
			writes.className += 1;
		},
	});
	Object.defineProperty(element, 'classList', {
		value: {
			toggle: (token: string, force?: boolean): boolean => {
				const classes = values.className.split(/\s+/u).filter(Boolean);
				const index = classes.indexOf(token);
				const enabled = force ?? index === -1;
				if (enabled && index === -1) classes.push(token);
				if (!enabled && index !== -1) classes.splice(index, 1);
				values.className = classes.join(' ');
				writes.className += 1;
				return enabled;
			},
		},
	});
	return { element, values, writes };
}
