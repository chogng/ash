import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, teardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { type IDisposable } from '../../../base/common/lifecycle.js';
import { installEditorTestDom } from './editorTestGlobals.js';

let browserEnvironment: JSDOM;
let installedGlobals: IDisposable;
let canvas: HTMLCanvasElement;

setup(() => {
	browserEnvironment = new JSDOM('<!doctype html><head><style>.owned { color: red; } .stanza-decoration-style-probe { --gpu-test: #123456; }</style></head><body><canvas></canvas></body>');
	installedGlobals = installEditorTestDom(browserEnvironment, [], {
		CSSStyleRule: browserEnvironment.window.CSSStyleRule,
		CSSImportRule: browserEnvironment.window.CSSImportRule,
	});
	canvas = browserEnvironment.window.document.querySelector('canvas')!;
});

teardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

test('ViewGpuContext and its shared CSS extractor import without creating a browser window', () => {
	const moduleUrl = new URL('../../browser/gpu/viewGpuContext.js', import.meta.url).href;
	const cssLoader = pathToFileURL(resolve('test/unit/ignore-css-loader.ts')).href;
	const result = spawnSync(
		process.execPath,
		[
			'--loader',
			cssLoader,
			'--input-type=module',
			'-e',
			`
		import assert from 'node:assert/strict';
		assert.equal(globalThis.window, undefined);
		const { ViewGpuContext } = await import(${JSON.stringify(moduleUrl)});
		ViewGpuContext.decorationCssRuleExtractor.clear();
		assert.equal(globalThis.window, undefined);
	`,
		],
		{ encoding: 'utf8' },
	);
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr);
});

test('DecorationCssRuleExtractor creates its probe on first use in the canvas document and retains rule caching', async () => {
	const { DecorationCssRuleExtractor } = await import('../../browser/gpu/css/decorationCssRuleExtractor.js');
	const document = canvas.ownerDocument;
	const originalCreateElement = document.createElement.bind(document);
	const created: HTMLElement[] = [];
	document.createElement = ((...args: Parameters<Document['createElement']>) => {
		const element = originalCreateElement(...args);
		created.push(element);
		return element;
	}) as Document['createElement'];
	using extractor = new DecorationCssRuleExtractor();
	assert.equal(created.length, 0);
	const first = extractor.getStyleRules(canvas, 'owned');
	assert.equal(first.length, 1);
	assert.deepEqual(
		created.map(element => element.tagName),
		['DIV', 'SPAN'],
	);
	assert.ok(created.every(element => element.ownerDocument === document));
	assert.equal(canvas.childElementCount, 0);
	document.styleSheets[0]!.insertRule('.owned { font-weight: bold; }', 1);
	assert.equal(extractor.getStyleRules(canvas, 'owned'), first);
	assert.equal(first.length, 1);
	extractor.clear();
	assert.equal(extractor.getStyleRules(canvas, 'owned').length, 2);
	assert.equal(created.length, 2);
	assert.equal(canvas.childElementCount, 0);
});

test('DecorationCssRuleExtractor retains CSS variable caching and clears it on theme changes', async () => {
	const { DecorationCssRuleExtractor } = await import('../../browser/gpu/css/decorationCssRuleExtractor.js');
	using extractor = new DecorationCssRuleExtractor();
	assert.equal(extractor.resolveCssVariable(canvas, '--gpu-test'), '#123456');
	const rule = canvas.ownerDocument.styleSheets[0]!.cssRules[1] as CSSStyleRule;
	rule.style.setProperty('--gpu-test', '#abcdef');
	assert.equal(extractor.resolveCssVariable(canvas, '--gpu-test'), '#123456');
	extractor.clear();
	assert.equal(extractor.resolveCssVariable(canvas, '--gpu-test'), '#abcdef');
	assert.equal(canvas.childElementCount, 0);
});

test('DecorationCssRuleExtractor disposal removes its owned probe and is safe before first use', async () => {
	const { DecorationCssRuleExtractor } = await import('../../browser/gpu/css/decorationCssRuleExtractor.js');
	new DecorationCssRuleExtractor().dispose();
	const extractor = new DecorationCssRuleExtractor();
	let probe: Node | undefined;
	const appendChild = canvas.appendChild.bind(canvas);
	canvas.appendChild = <T extends Node>(node: T): T => {
		probe = node;
		return appendChild(node);
	};
	extractor.getStyleRules(canvas, 'owned');
	assert.ok(probe);
	appendChild(probe);
	assert.equal(probe.parentNode, canvas);
	extractor.dispose();
	assert.equal(probe.parentNode, null);
});
