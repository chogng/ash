import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { WorkerDiffComputationService } from '../../../browser/services/workerDiffComputationService.js';
import { DiffModel } from '../../../common/diff/diffModel.js';
import { type DiffComputationRequest } from '../../../common/diff/diffComputationService.js';
import { TextModel } from '../../../common/model/textModel.js';
import { DiffTestPort } from './diffTestPort.js';

suite('Frontend diff Worker', () => {
	test('uses the same frontend service for concurrent comparisons', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const [first, second] = await Promise.all([
			service.compute(request('before 😀 after', 'before 🤖 after'), new AbortController().signal),
			service.compute(request('same\n', 'same'), new AbortController().signal),
		]);
		assert.deepEqual(first.rows[0]!.originalChanges, [{ startColumn: 7, endColumn: 9 }]);
		assert.deepEqual(second.rows.map(row => row.kind), ['unchanged', 'removed']);
	});

	test('cancels one comparison without discarding a newer result', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const original = Array.from({ length: 12_000 }, (_, index) => String(index)).join('\n');
		const controller = new AbortController();
		const pending = service.compute(request(original, original.split('\n').reverse().join('\n')), controller.signal);
		const rejected = assert.rejects(pending, { name: 'AbortError' });
		await new Promise(resolve => setTimeout(resolve, 0));
		controller.abort();
		const next = await service.compute(request('old', 'new'), new AbortController().signal);
		await rejected;
		assert.deepEqual(next.rows.map(row => row.kind), ['modified']);
	});

	test('disposal settles pending calls and terminates the owned port', async () => {
		const port = new DiffTestPort();
		using service = new WorkerDiffComputationService(() => port);
		const pending = service.compute(request('old', 'new'), new AbortController().signal);
		const rejected = assert.rejects(pending, /disposed/);
		service.dispose();
		await rejected;
		assert.equal(port.isDisposed, true);
		await assert.rejects(service.compute(request('', ''), new AbortController().signal), ReferenceError);
	});

	test('an already cancelled call never creates a Worker', async () => {
		using service = new WorkerDiffComputationService(() => { throw new Error('must not start'); });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(service.compute(request('', ''), controller.signal), { name: 'AbortError' });
	});

	test('rejects malformed Worker inputs and keeps independent requests usable', async () => {
		using service = new WorkerDiffComputationService(() => new DiffTestPort());
		const malformed = { original: { version: 1, text: 42 }, modified: { version: 1, text: 'text' } } as unknown as DiffComputationRequest;
		await assert.rejects(service.compute(malformed, new AbortController().signal), { name: 'WebWorkerRemoteError', message: 'Invalid editor diff request' });
		const next = await service.compute(request('', ''), new AbortController().signal);
		assert.deepEqual(next.hunks, []);
	});

	test('publishes only the latest unsaved TextModel versions', async () => {
		using original = new TextModel('before');
		using modified = new TextModel('before');
		using computationService = new WorkerDiffComputationService(() => new DiffTestPort());
		using model = new DiffModel({ original, modified, computationService });
		modified.setValue('obsolete');
		modified.setValue('current 😀');
		await new Promise<void>((resolve, reject) => {
			const listener = model.onDidChange(state => {
				if (state.kind === 'loading') {
					return;
				}
				listener.dispose();
				if (state.kind === 'error') {
					reject(state.error);
				} else {
					resolve();
				}
			});
		});
		assert.equal(model.state.modifiedVersion, modified.version);
		assert.equal(modified.getText(), 'current 😀');
		assert.deepEqual(model.diff!.rows.map(row => row.kind), ['modified']);
	});
});

function request(original: string, modified: string): DiffComputationRequest {
	return { original: { version: 1, text: original }, modified: { version: 1, text: modified } };
}
