import { TestWebWorkerService } from '../../../../platform/webWorker/test/browser/testWebWorkerService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { WorkerDiffComputationService } from '../../../browser/services/workerDiffComputationService.js';
import { WorkerBasedDiffProviderFactoryService } from '../../../browser/widget/diffEditor/diffProviderFactoryService.js';
import { DiffModel } from '../../../common/diff/diffModel.js';
import { type DiffComputationRequest } from '../../../common/diff/diffComputationService.js';
import { type IDocumentDiff, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { diffWorkerHandler, readDiffResult } from '../../../common/diff/diffWorker.js';
import { DetailedLineRangeMapping } from '../../../common/diff/rangeMapping.js';
import { TextModel } from '../../../common/model/textModel.js';
import { DiffTestPort } from './diffTestPort.js';

const options: IDocumentDiffProviderOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };

suite('Frontend diff Worker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('first provider prepares one Worker and factory disposal releases an unused client', () => {
		const ports: DiffTestPort[] = [];
		using factory = new WorkerBasedDiffProviderFactoryService(new TestWebWorkerService(() => {
			const port = new DiffTestPort();
			ports.push(port);
			return port;
		}));
		assert.equal(ports.length, 0);
		using first = factory.createDiffProvider();
		using second = factory.createDiffProvider();
		assert.equal(ports.length, 1);
		first.dispose();
		second.dispose();
		assert.equal(ports[0]!.isDisposed, false);
		factory.dispose();
		assert.equal(ports[0]!.isDisposed, true);
	});
	test('a Worker that fails during preparation is replaced on the first computation', async () => {
		using failures = new Emitter<unknown>();
		const ports: DiffTestPort[] = [];
		using factory = new WorkerBasedDiffProviderFactoryService(new TestWebWorkerService(() => {
			const port = Object.assign(new DiffTestPort(), { onFailure: failures.event });
			ports.push(port);
			return port;
		}));
		using provider = factory.createDiffProvider();
		failures.fire(new Error('Preparation failed'));
		using original = new TextModel('old');
		using modified = new TextModel('new');
		assert.equal((await provider.computeDiff(original, modified, options, CancellationToken.None)).changes.length, 1);
		assert.equal(ports.length, 2);
		assert.equal(ports[0]!.isDisposed, true);
	});
	test('shared Worker failure rejects pending work and allows the next comparison to recover', async () => {
		using failures = new Emitter<unknown>();
		const ports: DiffTestPort[] = [];
		using factory = new WorkerBasedDiffProviderFactoryService(new TestWebWorkerService(() => {
			const port = Object.assign(new DiffTestPort(), { onFailure: failures.event });
			ports.push(port);
			return port;
		}));
		using provider = factory.createDiffProvider();
		using original = new TextModel('old');
		using modified = new TextModel('new');
		const pending = provider.computeDiff(original, modified, options, CancellationToken.None);
		const rejected = assert.rejects(pending, /Worker crashed/);
		failures.fire(new Error('Worker crashed'));
		await rejected;
		assert.equal(ports[0]!.isDisposed, true);
		assert.equal((await provider.computeDiff(original, modified, options, CancellationToken.None)).changes.length, 1);
		assert.equal(ports.length, 2);
	});
	test('factory reuses its Worker across disposed providers while cancelling only their own requests', async () => {
		const ports: DiffTestPort[] = [];
		using factory = new WorkerBasedDiffProviderFactoryService(new TestWebWorkerService(() => {
			const port = new DiffTestPort();
			ports.push(port);
			return port;
		}));
		using first = factory.createDiffProvider();
		using second = factory.createDiffProvider();
		using original = new TextModel('old');
		using modified = new TextModel('new');
		const pending = first.computeDiff(original, modified, options, CancellationToken.None);
		const rejected = assert.rejects(pending, { name: 'CancellationError' });
		const surviving = second.computeDiff(original, modified, options, CancellationToken.None);
		first.dispose();
		await rejected;
		assert.equal((await surviving).changes.length, 1);
		second.dispose();
		assert.equal(ports.length, 1);
		assert.equal(ports[0]!.isDisposed, false);
		using replacement = factory.createDiffProvider();
		assert.equal((await replacement.computeDiff(original, modified, options, CancellationToken.None)).changes.length, 1);
		assert.equal(ports.length, 1);
		const closing = replacement.computeDiff(original, modified, options, CancellationToken.None);
		const closed = assert.rejects(closing, /disposed/);
		factory.dispose();
		await closed;
		assert.equal(ports[0]!.isDisposed, true);
		assert.throws(() => factory.createDiffProvider(), ReferenceError);
	});
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

	test('applies provider options while keeping whitespace-only changes non-identical', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const ignoredWhitespace = await compute(service, '  same  ', 'same', { ...options, ignoreTrimWhitespace: true });
		assert.deepEqual(ignoredWhitespace.changes, []);
		assert.equal(ignoredWhitespace.identical, false);
		const moved = await compute(service, 'move\nstay one\nstay two', 'stay one\nstay two\nmove', { ...options, computeMoves: true });
		assert.deepEqual(moved.moves.map(move => [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.modified.startLineNumber]), [[1, 3]]);
	});

	test('uses model languages to distinguish stylesheet names from unspaced subtraction', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const originalText = 'width: first-second;';
		const modifiedText = 'width: alpha-beta;';
		using original = new TextModel(originalText, { languageId: 'css' });
		using modified = new TextModel(modifiedText, { languageId: 'css' });
		for (const [originalLanguage, modifiedLanguage, expected] of [
			['css', 'css', [['first-second'], ['alpha-beta']]],
			['javascript', 'javascript', [['first', 'second'], ['alpha', 'beta']]],
			['css', 'javascript', [['first', 'second'], ['alpha', 'beta']]],
		] as const) {
			original.setLanguage(originalLanguage);
			modified.setLanguage(modifiedLanguage);
			const diff = await service.computeDiff(original, modified, options, CancellationToken.None);
			assert.deepEqual([
				diff.changes[0]!.innerChanges!.map(change => originalText.slice(change.originalRange.startColumn - 1, change.originalRange.endColumn - 1)),
				diff.changes[0]!.innerChanges!.map(change => modifiedText.slice(change.modifiedRange.startColumn - 1, change.modifiedRange.endColumn - 1)),
			], expected);
		}
	});

	test('recomputes diff highlights when model languages change without text edits', async () => {
		using original = new TextModel('.ash-old-host {', { languageId: 'css' });
		using modified = new TextModel('.ash-new-sidebar {', { languageId: 'css' });
		using diffProvider = new WorkerDiffComputationService(() => new DiffTestPort());
		using model = new DiffModel({ original, modified, diffProvider, diffOptions: options });
		const ready = (): Promise<void> => new Promise((resolve, reject) => {
			const listener = model.onDidChange(state => {
				if (state.kind === 'loading') return;
				listener.dispose();
				if (state.kind === 'error') reject(state.error);
				else resolve();
			});
		});
		await ready();
		assert.equal(model.diff!.rows.get(0)!.originalChanges.length, 1);
		let pending = ready();
		original.setLanguage('javascript');
		await pending;
		assert.equal(model.diff!.rows.get(0)!.originalChanges.length, 2);
		pending = ready();
		original.setLanguage('css');
		await pending;
		assert.equal(model.diff!.rows.get(0)!.originalChanges.length, 1);
		pending = ready();
		modified.setLanguage('javascript');
		await pending;
		assert.equal(model.diff!.rows.get(0)!.originalChanges.length, 2);
	});

	test('compares logical lines when document line endings differ', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const same = await compute(service, 'first\r\nsecond\r\n', 'first\nsecond\n');
		assert.deepEqual(same, { identical: true, quitEarly: false, changes: [], moves: [] });

		const changed = await compute(service, 'first\r\nold\r\nlast', 'first\nnew\nlast');
		assert.equal(changed.identical, false);
		assert.deepEqual(changed.changes.map(change => [
			change.original.startLineNumber,
			change.original.endLineNumberExclusive,
			change.modified.startLineNumber,
			change.modified.endLineNumberExclusive,
		]), [[2, 3, 2, 3]]);
		assert.deepEqual(changed.changes[0]!.innerChanges?.map(change => [
			change.originalRange.startColumn,
			change.originalRange.endColumn,
			change.modifiedRange.startColumn,
			change.modifiedRange.endColumn,
		]), [[1, 4, 1, 4]]);
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

	test('restores edited move mappings and their document coordinates across the Worker boundary', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const block = ['function load(input) {', '  return parse(input);', '}'];
		const stay = Array.from({ length: 5 }, (_, index) => `stay ${index}`);
		const result = await compute(service, ['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, ...block.map(line => line.replace('parse(input)', 'parse(updated)')), 'tail'].join('\n'), { ...options, computeMoves: true });
		assert.deepEqual(result.moves.map(move => ({
			original: [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.original.endLineNumberExclusive],
			modified: [move.lineRangeMapping.modified.startLineNumber, move.lineRangeMapping.modified.endLineNumberExclusive],
			changes: move.changes.map(change => [change.original.startLineNumber, change.modified.startLineNumber]),
		})), [{ original: [2, 5], modified: [7, 10], changes: [[3, 8]] }]);
		assert.ok(result.moves[0]!.changes[0] instanceof DetailedLineRangeMapping);
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

	test('rejects malformed language context at the Worker boundary', async () => {
		await assert.rejects(async () => diffWorkerHandler.handleRequest({
			request: { ...request('old', 'new'), options: { ...options, languageId: 42 } },
		}, new AbortController().signal), { name: 'TypeError', message: 'Invalid editor diff request' });
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
		assert.deepEqual(Array.from(model.diff!.rows).map(row => row.kind), ['modified']);
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
