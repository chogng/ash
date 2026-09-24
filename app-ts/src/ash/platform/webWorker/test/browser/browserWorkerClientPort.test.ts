import assert from 'node:assert/strict';
import { test } from 'mocha';
import { BrowserWorkerClientPort } from '../../browser/browserWorkerClientPort.js';

test('Browser Worker client port forwards messages and owns termination', () => {
	const worker = new TestWorker();
	const port = new BrowserWorkerClientPort(worker as unknown as Worker);
	const messages: unknown[] = [];
	const failures: unknown[] = [];
	using messageListener = port.onMessage(message => messages.push(message));
	using failureListener = port.onFailure(error => failures.push(error));

	const transfer = new ArrayBuffer(1);
	port.send({ kind: 'request' }, [transfer]);
	worker.fire('message', { data: { kind: 'response' } });
	const workerError = new Error('worker failed');
	worker.fire('error', { error: workerError, message: workerError.message });
	worker.fire('messageerror', {});

	assert.deepEqual(worker.sent, [{ message: { kind: 'request' }, transfer: [transfer] }]);
	assert.deepEqual(messages, [{ kind: 'response' }]);
	assert.deepEqual(failures, [workerError, new TypeError('Worker returned an unreadable message')]);

	port.dispose();
	assert.equal(worker.terminationCount, 1);
	assert.throws(() => port.send({ kind: 'late' }), /already disposed/);
	worker.fire('message', { data: { kind: 'late' } });
	assert.deepEqual(messages, [{ kind: 'response' }]);
});

type WorkerEventType = 'message' | 'error' | 'messageerror';

class TestWorker {
	private readonly listeners = new Map<WorkerEventType, Set<(event: never) => void>>();
	public readonly sent: { readonly message: unknown; readonly transfer: readonly Transferable[] }[] = [];
	public terminationCount = 0;

	public addEventListener(type: WorkerEventType, listener: (event: never) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	public removeEventListener(type: WorkerEventType, listener: (event: never) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	public postMessage(message: unknown, transfer: readonly Transferable[]): void {
		this.sent.push({ message, transfer });
	}

	public terminate(): void {
		this.terminationCount += 1;
	}

	public fire(type: WorkerEventType, event: object): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event as never);
	}
}
