import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ArrayQueue, binarySearch2, groupAdjacentBy, numberComparator, sumBy } from '../../common/arrays.js';
import { diffSets, intersection, SetWithKey } from '../../common/collections.js';
import { safeIntl } from '../../common/date.js';
import { createSingleCallFunction } from '../../common/functional.js';
import { HierarchicalKind } from '../../common/hierarchicalKind.js';
import { IdGenerator } from '../../common/idGenerator.js';
import { Mimes, normalizeMimeType } from '../../common/mime.js';
import { StopWatch } from '../../common/stopwatch.js';

test('array helpers preserve search, grouping, and queue boundaries', () => {
	const values = [1, 3, 5, 7];
	assert.equal(binarySearch2(values.length, index => numberComparator(values[index]!, 5)), 2);
	assert.equal(binarySearch2(values.length, index => numberComparator(values[index]!, 4)), -3);
	assert.deepEqual([...groupAdjacentBy([1, 3, 2, 4, 7], (left, right) => left % 2 === right % 2)], [[1, 3], [2, 4], [7]]);
	assert.equal(sumBy(values, value => value), 16);

	const queue = new ArrayQueue(values);
	assert.deepEqual(queue.takeWhile(value => value < 5), [1, 3]);
	assert.deepEqual(queue.takeFromEndWhile(value => value > 5), [7]);
	assert.equal(queue.peek(), 5);
	assert.equal(queue.removeLast(), 5);
	assert.equal(queue.dequeue(), undefined);
	assert.throws(() => queue.takeCount(1), RangeError);
});

test('keyed sets use semantic identity and collection diffs preserve values', () => {
	const values = new SetWithKey([{ id: 1, value: 'old' }], item => item.id);
	values.add({ id: 1, value: 'new' });
	assert.equal(values.size, 1);
	assert.equal([...values][0]?.value, 'new');
	assert.deepEqual(intersection(new Set([1, 2]), [2, 3]), new Set([2]));
	assert.deepEqual(diffSets(new Set([1, 2]), new Set([2, 3])), { removed: [1], added: [3] });
});

test('safe Intl factories are lazy and normalize invalid locale input', () => {
	const segmenter = safeIntl.Segmenter('not_a_locale', { granularity: 'word' });
	assert.equal(segmenter.hasValue, false);
	assert.equal(typeof segmenter.value.segment, 'function');
	assert.equal(segmenter.hasValue, true);
	assert.equal(safeIntl.Locale('').value.language.length > 0, true);
});

test('single-call functions retain their first result and always notify once', () => {
	let calls = 0;
	let notifications = 0;
	const once = createSingleCallFunction((value: number) => {
		calls += 1;
		return 4 + value;
	}, () => { notifications += 1; });
	assert.equal(once(3), 7);
	assert.equal(once(9), 7);
	assert.equal(calls, 1);
	assert.equal(notifications, 1);
});

test('hierarchical kinds, generated IDs, MIME values, and stopwatches expose stable semantics', () => {
	const source = new HierarchicalKind('source');
	const fixAll = source.append('fixAll');
	assert.equal(source.contains(fixAll), true);
	assert.equal(source.intersects(new HierarchicalKind('source.organizeImports')), true);
	assert.equal(HierarchicalKind.None.contains(source), false);

	const ids = new IdGenerator('widget-');
	assert.equal(ids.nextId(), 'widget-1');
	assert.equal(ids.nextId(), 'widget-2');
	assert.equal(Mimes.uriList, 'text/uri-list');
	assert.equal(normalizeMimeType('Text/HTML; charset=UTF-8'), 'text/html; charset=UTF-8');
	assert.equal(normalizeMimeType('invalid', true), undefined);

	const watch = StopWatch.create(false);
	watch.stop();
	const stopped = watch.elapsed();
	assert.equal(stopped >= 0, true);
	assert.equal(watch.elapsed(), stopped);
});
