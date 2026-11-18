import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ReentrancyBarrier } from '../../common/controlFlow.js';
import { BugIndicatingError } from '../../common/errors.js';

suite('ReentrancyBarrier', () => {
	test('suppresses feedback while allowing nested required work', () => {
		const barrier = new ReentrancyBarrier();
		const seen: string[] = [];
		const synchronize = barrier.makeExclusiveOrSkip((source: string) => {
			assert.equal(barrier.isOccupied, true);
			seen.push(source);
			synchronize('scroll feedback');
		});
		barrier.run(() => {
			barrier.run(() => {
				seen.push('zone update');
				synchronize('scroll during zone update');
			});
			assert.equal(barrier.isOccupied, true);
			synchronize('scroll during layout');
		});
		synchronize('user scroll');
		assert.deepEqual(seen, ['zone update', 'user scroll']);
		assert.equal(barrier.isOccupied, false);
	});

	test('reports strict reentry and restores the barrier after an exception', () => {
		const barrier = new ReentrancyBarrier();
		assert.throws(() => barrier.runExclusivelyOrThrow(() => {
			barrier.runExclusivelyOrThrow(() => assert.fail('Callback reentered'));
		}), BugIndicatingError);
		assert.equal(barrier.isOccupied, false);
		barrier.runExclusivelyOrThrow(() => assert.equal(barrier.isOccupied, true));
	});
});
