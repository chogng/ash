import { h } from '../../../../../base/browser/dom.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ICodeEditor, IContentWidget } from '../../../../browser/editorBrowser.js';
import { Position } from '../../../../common/core/position.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	HTMLButtonElement: environment.window.HTMLButtonElement,
	Event: environment.window.Event,
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { InlineProgressManager } = await import('../../browser/inlineProgress.js');

suiteTeardown(() => environment.window.close());

test('InlineProgressManager delays, positions, cancels, and releases its widget', async () => {
	const container = h(environment.window.document, 'main');
	let widget: IContentWidget | undefined;
	let removed = false;
	let cancelled = false;
	const editor = {
		getContainerDomNode: () => container,
		addContentWidget: (value: IContentWidget) => { widget = value; },
		layoutContentWidget: () => {},
		removeContentWidget: (value: IContentWidget) => {
			if (widget === value) removed = true;
		},
	} as unknown as ICodeEditor;
	using services = new ServiceContainer();
	using manager = new InlineProgressManager('test', editor, services);
	let finish: ((value: string) => void) | undefined;
	const operation = manager.showWhile(new Position(2, 3), 'Working', new Promise(resolve => { finish = resolve; }), {
		cancel: () => { cancelled = true; },
	}, 0);
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.ok(widget);
	assert.deepEqual(widget.getPosition()?.position, new Position(2, 3));
	widget.getDomNode().click();
	assert.equal(cancelled, true);
	finish?.('done');
	assert.equal(await operation, 'done');
	assert.equal(removed, true);
});
