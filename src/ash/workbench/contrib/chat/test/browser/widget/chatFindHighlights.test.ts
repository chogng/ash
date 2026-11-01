import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { createChatFindHighlightRegistry, supportsCssHighlightApi } from '../../../browser/widget/chatFind/chatFindHighlights.js';

suite('Chat Find highlights', () => {
	test('clearing one conversation preserves another window-local owner and active highlight priority', () => {
		class Highlight {
			public readonly ranges: Range[] = [];
			public priority = 0;
			public add(range: Range): void { this.ranges.push(range); }
		}
		const displayed = new Map<string, unknown>();
		const window = { Highlight, CSS: { highlights: displayed } };
		assert.equal(supportsCssHighlightApi(window), true);
		const registry = createChatFindHighlightRegistry(window);
		const first = {}; const second = {};
		const a = {} as Range; const b = {} as Range;
		registry.setRanges(first, 'all', [a]);
		registry.setRanges(second, 'all', [b]);
		registry.setRanges(first, 'active', [a], 1);
		assert.deepEqual((displayed.get('all') as Highlight).ranges, [a, b]);
		assert.equal((displayed.get('active') as Highlight).priority, 1);
		registry.clear(first);
		assert.deepEqual((displayed.get('all') as Highlight).ranges, [b]);
		assert.equal(displayed.has('active'), false);
		registry.clear(second);
		assert.equal(displayed.size, 0);
	});

	test('unsupported highlight APIs still allow lifecycle cleanup', () => {
		assert.equal(supportsCssHighlightApi({}), false);
		const owner = {};
		const registry = createChatFindHighlightRegistry({});
		registry.setRanges(owner, 'all', [{} as Range]);
		registry.clear(owner);
	});
});
