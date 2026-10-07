import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { renderSCMHistoryItemGraph, toISCMHistoryItemViewModelArray } from '../../browser/scmHistory.js';
import type { ISCMHistoryItem } from '../../common/history.js';

suite('SCM history graph', () => {
	test('connects a merge to its additional parent when that parent already has a lane', () => {
		const history: ISCMHistoryItem[] = [
			{ id: 'tip', parentIds: ['merge', 'base'], subject: 'tip', message: 'tip' },
			{ id: 'merge', parentIds: ['main', 'base'], subject: 'merge', message: 'merge' },
			{ id: 'main', parentIds: ['base'], subject: 'main', message: 'main' },
			{ id: 'base', parentIds: ['root'], subject: 'base', message: 'base' },
			{ id: 'root', parentIds: [], subject: 'root', message: 'root' },
		];
		const environment = new JSDOM();
		try {
			const rows = toISCMHistoryItemViewModelArray(history);
			const graph = renderSCMHistoryItemGraph(rows[1], 22, environment.window.document);
			const branchColor = rows[1].outputSwimlanes[2].color;
			const branchPaths = [...graph.querySelectorAll('path')].filter(path => path.dataset.laneColor === String(branchColor));
			assert.ok(branchPaths.some(path => path.getAttribute('d')?.endsWith('33 22')), 'The new merge edge must reach its own lane at x=33.');
			const base = renderSCMHistoryItemGraph(rows[3], 22, environment.window.document);
			assert.equal(base.querySelectorAll('path[d$="H 11"]').length, 2, 'Both side lanes must reconnect to the base commit.');
			assert.equal(rows[3].outputSwimlanes.length, 1);
		} finally {
			environment.window.close();
		}
	});

	test('retains another branch across a root commit', () => {
		const rows = toISCMHistoryItemViewModelArray([
			{ id: 'merge', parentIds: ['root', 'other'], subject: 'merge', message: 'merge' },
			{ id: 'root', parentIds: [], subject: 'root', message: 'root' },
			{ id: 'other', parentIds: [], subject: 'other', message: 'other' },
		]);
		assert.deepEqual(rows[1].outputSwimlanes, [rows[0].outputSwimlanes[1]]);
		const environment = new JSDOM();
		try {
			const graph = renderSCMHistoryItemGraph(rows[1], 22, environment.window.document);
			assert.equal(graph.querySelectorAll('path[data-lane-color="1"][d$="11 16 V 22"]').length, 1, 'The other branch must continue past the root commit.');
			assert.equal(graph.querySelector('circle')?.getAttribute('data-lane-color'), '0', 'The root keeps its own branch color.');
		} finally {
			environment.window.close();
		}
	});
});
