import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { WorkerDiffComputationService } from '../../../browser/services/workerDiffComputationService.js';
import { DiffModel } from '../../../common/diff/diffModel.js';
import { type DiffComputationRequest } from '../../../common/diff/diffComputationService.js';
import { type IDocumentDiff, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { readDiffResult } from '../../../common/diff/diffWorker.js';
import { DetailedLineRangeMapping } from '../../../common/diff/rangeMapping.js';
import { TextModel } from '../../../common/model/textModel.js';
import { DiffTestPort } from './diffTestPort.js';

const options: IDocumentDiffProviderOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };

suite('Frontend diff Worker', () => {
	test('uses the same frontend provider for concurrent comparisons', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const [first, second] = await Promise.all([
			compute(service, 'before 😀 after', 'before 🤖 after'),
			compute(service, 'same\n', 'same'),
		]);
		assert.equal(first.identical, false);
		assert.equal(first.quitEarly, false);
		assert.deepEqual(first.changes[0]!.innerChanges?.map(change => [change.originalRange.startColumn, change.originalRange.endColumn]), [[8, 10]]);
		assert.ok(first.changes[0] instanceof DetailedLineRangeMapping);
		assert.equal(first.changes[0]!.flip().original.startLineNumber, 1);
		assert.deepEqual(second.changes.map(change => [change.original.startLineNumber, change.original.endLineNumberExclusive, change.modified.startLineNumber]), [[2, 3, 2]]);
	});

	test('applies provider options while preserving byte-wise identical state', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const ignoredWhitespace = await compute(service, '  same  ', 'same', { ...options, ignoreTrimWhitespace: true });
		assert.deepEqual(ignoredWhitespace.changes, []);
		assert.equal(ignoredWhitespace.identical, false);
		const moved = await compute(service, 'move\nstay one\nstay two', 'stay one\nstay two\nmove', { ...options, computeMoves: true });
		assert.deepEqual(moved.moves.map(move => [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.modified.startLineNumber]), [[1, 3]]);
	});

	test('cancels one comparison without discarding a newer result', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const text = Array.from({ length: 12_000 }, (_, index) => String(index)).join('\n');
		using original = new TextModel(text);
		using modified = new TextModel(text.split('\n').reverse().join('\n'));
		using source = new CancellationTokenSource();
		const pending = service.computeDiff(original, modified, options, source.token);
		const rejected = assert.rejects(pending, { name: 'CancellationError' });
		await new Promise(resolve => setTimeout(resolve, 0));
		source.cancel();
		const next = await compute(service, 'old', 'new');
		await rejected;
		assert.equal(next.changes.length, 1);
	});

	test('disposal settles pending calls and terminates the owned port', async () => {
		const port = new DiffTestPort();
		using service = new WorkerDiffComputationService(() => port);
		using original = new TextModel('old');
		using modified = new TextModel('new');
		const pending = service.computeDiff(original, modified, options, CancellationToken.None);
		const rejected = assert.rejects(pending, /disposed/);
		service.dispose();
		await rejected;
		assert.equal(port.isDisposed, true);
		await assert.rejects(service.computeDiff(original, modified, options, CancellationToken.None), ReferenceError);
	});

	test('an already cancelled call never creates a Worker', async () => {
		using service = new WorkerDiffComputationService(() => { throw new Error('must not start'); });
		using original = new TextModel('');
		using modified = new TextModel('');
		await assert.rejects(service.computeDiff(original, modified, options, CancellationToken.Cancelled), { name: 'CancellationError' });
	});

	test('identical documents return the standard empty result without creating a Worker', async () => {
		using service = new WorkerDiffComputationService(() => { throw new Error('must not start'); });
		const result = await compute(service, 'same', 'same');
		assert.deepEqual(result, { identical: true, quitEarly: false, changes: [], moves: [] });
	});

	test('rejects malformed Worker options and keeps independent requests usable', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		await assert.rejects(compute(service, 'old', 'new', { ...options, maxComputationTimeMs: Number.NaN }), {
			name: 'WebWorkerRemoteError', message: 'Invalid editor diff request',
		});
		const next = await compute(service, '', '');
		assert.deepEqual(next.changes, []);
		assert.equal(next.identical, true);
	});

	test('rejects out-of-range standard mappings returned by a Worker', () => {
		assert.throws(() => readDiffResult({
			changes: [{
				original: { startLineNumber: 1, endLineNumberExclusive: 2 },
				modified: { startLineNumber: 1, endLineNumberExclusive: 2 },
				innerChanges: [{
					originalRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 10 },
					modifiedRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
				}],
			}],
			moves: [],
			hitTimeout: false,
		}, request('old', 'new')), /Invalid editor diff text range/);
	});

	test('publishes only the latest unsaved TextModel versions', async () => {
		using original = new TextModel('before');
		using modified = new TextModel('before');
		using diffProvider = new WorkerDiffComputationService(() => new DiffTestPort());
		using model = new DiffModel({ original, modified, diffProvider, diffOptions: options });
		modified.setValue('obsolete');
		modified.setValue('current 😀');
		await new Promise<void>((resolve, reject) => {
			const listener = model.onDidChange(state => {
				if (state.kind === 'loading') return;
				listener.dispose();
				if (state.kind === 'error') reject(state.error);
				else resolve();
			});
		});
		assert.equal(model.state.modifiedVersion, modified.version);
		assert.equal(modified.getText(), 'current 😀');
		assert.deepEqual(model.diff!.rows.map(row => row.kind), ['modified']);
	});
});

async function compute(service: WorkerDiffComputationService, originalText: string, modifiedText: string, diffOptions = options): Promise<IDocumentDiff> {
	using original = new TextModel(originalText);
	using modified = new TextModel(modifiedText);
	return service.computeDiff(original, modified, diffOptions, CancellationToken.None);
}

function request(original: string, modified: string): DiffComputationRequest {
	return { original: { version: 1, text: original }, modified: { version: 1, text: modified }, options };
}
