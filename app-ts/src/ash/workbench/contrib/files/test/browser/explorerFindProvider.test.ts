import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ExplorerFindProvider } from '../../browser/views/explorerViewer.js';

test('Explorer find opens with Ctrl+F, searches file names, and returns focus on Escape', () => {
	const browser = new JSDOM('<!doctype html><body><header></header><div tabindex="0"></div></body>');
	const header = browser.window.document.querySelector('header')!;
	const treeElement = browser.window.document.querySelector('div')!;
	const patterns: string[] = [];
	let nextCount = 0;
	const tree = {
		element: treeElement,
		setFindPattern: (pattern: string) => { patterns.push(pattern); },
		findNext: () => { nextCount += 1; return undefined; },
		clearFind: () => { patterns.push(''); },
		domFocus: () => { treeElement.focus(); },
	};
	using provider = new ExplorerFindProvider(tree, header);
	const input = header.querySelector('input')!;
	assert.equal(input.hidden, true);
	treeElement.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
	assert.equal(input.hidden, false);
	assert.equal(browser.window.document.activeElement, input);
	input.value = 'report';
	input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
	assert.deepEqual(patterns, ['report']);
	input.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(nextCount, 1);
	input.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(input.hidden, true);
	assert.equal(browser.window.document.activeElement, treeElement);
	assert.deepEqual(patterns, ['report', '']);
	browser.window.close();
});
