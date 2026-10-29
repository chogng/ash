import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { TreeVisibility } from '../../../../../base/browser/ui/tree/tree.js';
import type { DebugConsoleEntry } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { ReplFilter } from '../../browser/replFilter.js';

suite('Debug Console filtering', () => {
	test('combines alternatives and gives exclusions priority regardless of query order', () => {
		const filter = new ReplFilter();
		const entries = ['network ready', 'network denied', 'disk ready', 'idle'].map(output => entry(output));
		const visible = () => entries.filter(value => filter.filter(value, TreeVisibility.Visible) === TreeVisibility.Visible).map(value => value.output);
		filter.filterQuery = 'network, disk';
		assert.deepEqual(visible(), ['network ready', 'network denied', 'disk ready']);
		for (const query of ['ready, !disk', '!disk, ready']) {
			filter.filterQuery = query;
			assert.deepEqual(visible(), ['network ready']);
		}
		filter.filterQuery = '!ready';
		assert.deepEqual(visible(), ['network denied', 'idle']);
	});

	test('matches text case insensitively and in character order', () => {
		const filter = new ReplFilter();
		filter.filterQuery = 'NwRd';
		assert.equal(filter.filter(entry('Network Ready'), TreeVisibility.Visible), TreeVisibility.Visible);
		assert.equal(filter.filter(entry('Ready Network'), TreeVisibility.Visible), TreeVisibility.Hidden);
		assert.deepEqual(ReplFilter.matchQuery('日志', '开始记录日志'), [{ start: 4, end: 6 }]);
	});

	test('replacing or clearing the query discards previous include and exclude terms', () => {
		const filter = new ReplFilter();
		filter.filterQuery = 'disk, !ready';
		assert.equal(filter.filter(entry('network ready'), TreeVisibility.Visible), TreeVisibility.Hidden);
		filter.filterQuery = ' network , , ! , ';
		assert.equal(filter.filter(entry('network ready'), TreeVisibility.Visible), TreeVisibility.Visible);
		filter.filterQuery = ' , ';
		assert.equal(filter.filter(entry('disk ready'), TreeVisibility.Visible), TreeVisibility.Visible);
	});

	test('preserves expression input and evaluation results even when their text is excluded', () => {
		const filter = new ReplFilter();
		filter.filterQuery = 'other, !value';
		for (const kind of ['input', 'evaluation'] as const) {
			assert.equal(filter.filter(entry('value', kind), TreeVisibility.Hidden), TreeVisibility.Visible);
		}
		assert.equal(filter.filter(entry('value'), TreeVisibility.Visible), TreeVisibility.Hidden);
	});

	test('distinguishes unmatched group context from explicitly excluded groups', () => {
		const filter = new ReplFilter();
		filter.filterQuery = 'problem, !secret';
		assert.equal(filter.filter(entry('request', 'group'), TreeVisibility.Visible), TreeVisibility.Recurse);
		assert.equal(filter.filter(entry('problem', 'group'), TreeVisibility.Visible), TreeVisibility.Visible);
		assert.equal(filter.filter(entry('secret problem', 'group'), TreeVisibility.Visible), TreeVisibility.Hidden);
		assert.equal(filter.filter(entry('problem'), TreeVisibility.Recurse), TreeVisibility.Visible);
		assert.equal(filter.filter(entry('unrelated'), TreeVisibility.Visible), TreeVisibility.Hidden);
	});

	test('inherits parent visibility when the query only excludes text', () => {
		const filter = new ReplFilter();
		filter.filterQuery = '!secret';
		assert.equal(filter.filter(entry('public'), TreeVisibility.Visible), TreeVisibility.Visible);
		assert.equal(filter.filter(entry('public'), TreeVisibility.Hidden), TreeVisibility.Hidden);
		assert.equal(filter.filter(entry('secret'), TreeVisibility.Visible), TreeVisibility.Hidden);
	});
});

function entry(output: string, kind: DebugConsoleEntry['kind'] = 'output'): DebugConsoleEntry {
	return {
		id: 1,
		sessionId: 'session',
		kind,
		output,
		category: 'console',
		parentId: null,
		collapsed: false,
		variablesReference: null,
		source: null,
		line: null,
		column: null,
		data: null,
	};
}
