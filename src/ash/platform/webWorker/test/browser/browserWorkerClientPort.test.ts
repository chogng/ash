import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WebWorkerDescriptor } from '../../browser/webWorkerDescriptor.js';
import { IWebWorkerService } from '../../browser/webWorkerService.js';
import { WebWorkerService } from '../../browser/webWorkerServiceImpl.js';
import { StandaloneWebWorkerService } from '../../../../editor/standalone/browser/services/standaloneWebWorkerService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { WorkerBasedDiffProviderFactoryService } from '../../../../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { URI } from '../../../../base/common/uri.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { BrowserWorkerClientPort } from '../../browser/browserWorkerClientPort.js';

suite('Browser Worker service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('Promise Worker preserves queued message order and terminates after disposal', async () => {
		let resolve!: (worker: Worker) => void;
		const pending = new Promise<Worker>(done => {
			resolve = done;
		});
		const port = new BrowserWorkerClientPort(pending);
		port.send({ order: 1 });
		port.send({ order: 2 });
		const worker = new TestWorker();
		resolve(worker as unknown as Worker);
		await pending;
		assert.deepEqual(worker.sent, [
			{ message: { order: 1 }, transfer: [] },
			{ message: { order: 2 }, transfer: [] },
		]);
		port.dispose();
		assert.equal(worker.terminationCount, 1);
	});

	test('a Worker created after its owner was disposed is terminated without sending queued data', async () => {
		let resolve!: (worker: Worker) => void;
		const pending = new Promise<Worker>(done => {
			resolve = done;
		});
		const port = new BrowserWorkerClientPort(pending);
		port.send({ abandoned: true });
		port.dispose();
		const worker = new TestWorker();
		resolve(worker as unknown as Worker);
		await pending;
		assert.equal(worker.terminationCount, 1);
		assert.deepEqual(worker.sent, []);
	});

	test('asynchronous Worker creation failure rejects its pending client requests', async () => {
		const { WebWorkerClient } = await import('../../../../base/common/worker/webWorker.js');
		using client = new WebWorkerClient<{ $ready(): void }>(
			new BrowserWorkerClientPort(Promise.reject(new Error('Worker startup failed'))),
		);
		await assert.rejects(client.proxy.$ready(), /Worker startup failed/);
		assert.throws(() => client.proxy, /Worker startup failed/);
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

	test('Worker service resolves deferred locations and owns the client returned for an existing Worker', async () => {
		const service = new WebWorkerService();
		let resolved = 0;
		const descriptor = new WebWorkerDescriptor({
			label: 'calculator',
			esmModuleLocation: () => {
				resolved++;
				return URI.parse('https://ash.example/worker.js');
			},
		});
		assert.equal(resolved, 0);
		assert.equal(service.getWorkerUrl(descriptor), 'https://ash.example/worker.js');
		assert.equal(resolved, 1);
		assert.equal(
			service.getWorkerUrl(
				new WebWorkerDescriptor({
					label: 'bundled',
					esmModuleLocationBundler: new URL('https://ash.example/bundled.js'),
				}),
			),
			'https://ash.example/bundled.js',
		);
		const worker = new TestWorker();
		const client = service.createWorkerClient<{ $double(value: number): number }>(worker as unknown as Worker);
		const result = client.proxy.$double(4);
		const request = worker.sent[0]!.message as Record<string, unknown>;
		worker.fire('message', {
			data: {
				protocol: request.protocol,
				version: request.version,
				kind: 'result',
				requestId: request.requestId,
				result: 8,
			},
		});
		assert.equal(await result, 8);
		client.dispose();
		assert.equal(worker.terminationCount, 1);
	});

	test('Standalone host Worker override wins over its URL and bundled factories; explicit Workers bypass overrides', async () => {
		const worker = new TestWorker();
		let overrides = 0;
		const service = new StandaloneWebWorkerService(() => ({
			getWorker: (module, label) => {
				assert.equal(module, 'workerMain.js');
				assert.equal(label, 'editor');
				overrides++;
				return Promise.resolve(worker as unknown as Worker);
			},
			getWorkerUrl: () => {
				throw new Error('Worker URL must not override a supplied host Worker');
			},
		}));
		const client = service.createWorkerClient(
			new WebWorkerDescriptor({
				label: 'editor',
				createWorker: () => {
					throw new Error('Bundled fallback must not run');
				},
			}),
		);
		client.dispose();
		await Promise.resolve();
		assert.equal(worker.terminationCount, 1);
		const explicit = new TestWorker();
		service.createWorkerClient(explicit as unknown as Worker).dispose();
		assert.equal(explicit.terminationCount, 1);
		assert.equal(overrides, 1);
	});

	test('Standalone host URL resolution overrides a descriptor module location', () => {
		const service = new StandaloneWebWorkerService(() => ({
			getWorkerUrl: () => 'https://host.example/custom-worker.js',
		}));
		assert.equal(
			service.getWorkerUrl(
				new WebWorkerDescriptor({
					label: 'editor',
					esmModuleLocation: URI.parse('https://ash.example/default.js'),
				}),
			),
			'https://host.example/custom-worker.js',
		);
	});

	test('production Diff factory requires the Worker service and starts one Worker with its first provider', async () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(WorkerBasedDiffProviderFactoryService), /IWebWorkerService/);
		const worker = new TestWorker();
		let created = 0;
		services.registerInstance(
			IWebWorkerService,
			new (class extends WebWorkerService {
				protected override _createWorker(descriptor: WebWorkerDescriptor): Promise<Worker> {
					assert.equal(descriptor.label, 'ash-editor-diff');
					created++;
					return Promise.resolve(worker as unknown as Worker);
				}
			})(),
		);
		using factory = services.createInstance(WorkerBasedDiffProviderFactoryService);
		assert.equal(created, 0);
		using provider = factory.createDiffProvider();
		assert.equal(typeof provider.computeDiff, 'function');
		assert.equal(created, 1);
		using second = factory.createDiffProvider();
		assert.equal(created, 1);
		factory.dispose();
		await Promise.resolve();
		assert.equal(worker.terminationCount, 1);
	});
});
