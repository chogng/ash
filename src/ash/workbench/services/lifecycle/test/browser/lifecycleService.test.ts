import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suite, test } from 'mocha';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { BrowserLifecycleService } from '../../browser/lifecycleService.js';
import { LifecyclePhase, StartupKind, ShutdownVetoError } from '../../common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { LifecycleMainService, windowCloseResponseIpcRoute } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import type { ISandboxIpcRenderer } from '../../../../../base/parts/sandbox/common/sandboxTypes.js';
import type { WindowCloseResponse } from '../../../../../platform/window/common/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Window shutdown diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names only unfinished vetoes, joins and final captures without changing completion', async () => {
		mock.timers.enable({ apis: ['setInterval'] });
		const browser = new JSDOM('<!doctype html><body></body>');
		try {
			using services = createLifecycleServices(browser);
			const warnings: unknown[][] = [];
			services.get(ILogService).warn = (...args: unknown[]) => {
				warnings.push(args);
			};
			using lifecycle = services.createInstance(BrowserLifecycleService, {
				ownerWindow: browser.window as unknown as Window,
				onError: () => undefined,
			});
			const veto = new DeferredPromise<boolean>();
			const join = new DeferredPromise<void>();
			const final = new DeferredPromise<void>();
			using beforeShutdown = lifecycle.onBeforeShutdown(event => {
				event.veto(Promise.resolve(false), 'finished check');
				event.veto(veto.p, 'backup check');
			});
			using willShutdown = lifecycle.onWillShutdown(event => {
				event.join(Promise.resolve(), 'finished save');
				event.join(join.p, 'storage save');
				event.join(() => final.p, 'final backup');
			});
			let completed = false;
			const shutdown = lifecycle.shutdown('reload').then(() => {
				completed = true;
			});
			for (const [phase, label, release] of [
				['veto', 'backup check', () => veto.complete(false)],
				['join', 'storage save', () => join.complete()],
				['final', 'final backup', () => final.complete()],
			] as const) {
				await new Promise(resolve => setImmediate(resolve));
				mock.timers.tick(10_000);
				assert.equal(completed, false);
				assert.deepEqual(warnings.at(-1)?.slice(0, 2), ['lifecycle', 'Window shutdown is still waiting']);
				assert.deepEqual(warnings.at(-1)?.[2], {
					reason: 'reload',
					elapsedMs: (warnings.at(-1)![2] as { elapsedMs: number }).elapsedMs,
					pending: [{ phase, label }],
				});
				await release();
			}
			await shutdown;
			mock.timers.tick(30_000);
			assert.equal(warnings.length, 3);
			assert.equal(completed, true);
		} finally {
			browser.window.close();
			mock.timers.reset();
		}
	});

	test('failed attempts clear diagnostics and disposing a waiting window stops its timer', async () => {
		mock.timers.enable({ apis: ['setInterval'] });
		const browser = new JSDOM('<!doctype html><body></body>');
		try {
			using services = createLifecycleServices(browser);
			const warnings: unknown[][] = [];
			services.get(ILogService).warn = (...args: unknown[]) => {
				warnings.push(args);
			};
			using lifecycle = services.createInstance(BrowserLifecycleService, {
				ownerWindow: browser.window as unknown as Window,
				onError: () => undefined,
			});
			const pending = new DeferredPromise<void>();
			let attempts = 0;
			using willShutdown = lifecycle.onWillShutdown(event => event.join(++attempts === 1 ? Promise.reject(new Error('save failed')) : pending.p, 'storage'));
			await assert.rejects(lifecycle.shutdown('reload'), /shutdown participants failed/);
			mock.timers.tick(10_000);
			assert.deepEqual(warnings, []);
			const shutdown = lifecycle.shutdown('windowClose');
			await new Promise(resolve => setImmediate(resolve));
			mock.timers.tick(10_000);
			assert.equal((warnings[0]![2] as { reason: string }).reason, 'windowClose');
			lifecycle.dispose();
			mock.timers.tick(30_000);
			assert.equal(warnings.length, 1);
			await pending.complete();
			await shutdown;
		} finally {
			browser.window.close();
			mock.timers.reset();
		}
	});
});

test('BrowserLifecycleService joins participants once before completing shutdown', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const errors: unknown[] = [];
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: (error: unknown) => errors.push(error),
	});
	const events: string[] = [];
	lifecycle.onWillShutdown(event => {
		events.push(`will:${event.reason}`);
		event.join(
			Promise.resolve().then(() => {
				events.push('joined');
			}),
			'test participant',
		);
	});
	lifecycle.onDidShutdown(reason => events.push(`did:${reason}`));
	const first = lifecycle.shutdown('reload');
	assert.equal(lifecycle.shutdown('quit'), first);
	await first;
	assert.deepEqual(events, ['will:reload', 'joined', 'did:reload']);
	assert.equal(lifecycle.willShutdown, true);
	assert.deepEqual(errors, []);
	browser.window.close();
});

test('BrowserLifecycleService reports pagehide participant failures', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const errors: unknown[] = [];
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: (error: unknown) => errors.push(error),
	});
	lifecycle.onWillShutdown(event => event.join(Promise.reject(new Error('flush failed')), 'failing flush'));
	browser.window.dispatchEvent(new browser.window.PageTransitionEvent('pagehide'));
	await new Promise(resolve => globalThis.setTimeout(resolve, 0));
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /shutdown participants failed/iu);
	browser.window.close();
});

test('BrowserLifecycleService returns the same shutdown promise during onWillShutdown', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	let reentrant: Promise<void> | undefined;
	lifecycle.onWillShutdown(() => {
		reentrant = lifecycle.shutdown('quit');
	});
	const initial = lifecycle.shutdown('reload');
	assert.equal(reentrant, initial);
	await initial;
	browser.window.close();
});

test('BrowserLifecycleService retries a failed shutdown without publishing completion', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	let attempts = 0;
	const completed: string[] = [];
	lifecycle.onWillShutdown(event => event.join(++attempts === 1 ? Promise.reject(new Error('save failed')) : Promise.resolve(), 'backup'));
	lifecycle.onDidShutdown(reason => completed.push(reason));
	await assert.rejects(lifecycle.shutdown('windowClose'), /shutdown participants failed/);
	assert.equal(lifecycle.willShutdown, false);
	assert.deepEqual(completed, []);
	await lifecycle.shutdown('windowClose');
	assert.equal(lifecycle.willShutdown, true);
	assert.deepEqual(completed, ['windowClose']);
	browser.window.close();
});

test('BrowserLifecycleService waits for an asynchronous veto before shutdown and permits retry', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	let shouldVeto = true;
	let reentrant: Promise<void> | undefined;
	const events: string[] = [];
	lifecycle.onBeforeShutdown(event => {
		reentrant = lifecycle.shutdown('quit');
		event.veto(Promise.resolve(shouldVeto), 'editor');
	});
	lifecycle.onShutdownVeto(() => events.push('veto'));
	lifecycle.onWillShutdown(() => events.push('will'));
	const first = lifecycle.shutdown('windowClose');
	assert.equal(reentrant, first);
	await assert.rejects(first, ShutdownVetoError);
	assert.deepEqual({ events, willShutdown: lifecycle.willShutdown }, { events: ['veto'], willShutdown: false });
	shouldVeto = false;
	await lifecycle.shutdown('windowClose');
	assert.deepEqual(events, ['veto', 'will']);
	browser.window.close();
});

test('BrowserLifecycleService treats a rejected pre-shutdown check as a veto error', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	const errors: string[] = [];
	lifecycle.onBeforeShutdown(event => event.veto(Promise.reject(new Error('backup failed')), 'backup'));
	lifecycle.onBeforeShutdownError(event => errors.push(event.error.message));
	lifecycle.onWillShutdown(() => errors.push('will'));
	await assert.rejects(lifecycle.shutdown('windowClose'), /shutdown vetoes failed/);
	assert.deepEqual({ errors, willShutdown: lifecycle.willShutdown }, { errors: ["Shutdown veto 'backup' failed"], willShutdown: false });
	browser.window.close();
});

test('window lifecycle releases all reached startup milestones and rejects backwards progress', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	const milestones: LifecyclePhase[] = [];
	const ready = lifecycle.when(LifecyclePhase.Ready).then(() => milestones.push(LifecyclePhase.Ready));
	const restored = lifecycle.when(LifecyclePhase.Restored).then(() => milestones.push(LifecyclePhase.Restored));
	assert.equal(lifecycle.when(LifecyclePhase.Eventually), lifecycle.when(LifecyclePhase.Eventually));
	const eventually = lifecycle.when(LifecyclePhase.Eventually).then(() => milestones.push(LifecyclePhase.Eventually));
	lifecycle.phase = LifecyclePhase.Restored;
	await Promise.all([ready, restored]);
	assert.deepEqual(milestones, [LifecyclePhase.Ready, LifecyclePhase.Restored]);
	assert.throws(() => {
		lifecycle.phase = LifecyclePhase.Ready;
	}, /cannot go backwards/);
	lifecycle.phase = LifecyclePhase.Eventually;
	await eventually;
	await lifecycle.when(LifecyclePhase.Ready);
	assert.deepEqual(milestones, [LifecyclePhase.Ready, LifecyclePhase.Restored, LifecyclePhase.Eventually]);
	await lifecycle.shutdown('quit');
	assert.deepEqual({ phase: lifecycle.phase, willShutdown: lifecycle.willShutdown }, { phase: LifecyclePhase.Eventually, willShutdown: true });
	browser.window.close();
});

for (const [reason, expected] of [
	['reload', StartupKind.ReloadedWindow],
	['load', StartupKind.ReopenedWindow],
	['quit', StartupKind.NewWindow],
] as const) {
	test(`window startup consumes the previous ${reason} shutdown exactly once`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		using firstServices = createLifecycleServices(browser);
		using first = firstServices.createInstance(BrowserLifecycleService, {
			ownerWindow: browser.window as unknown as Window,
			onError: () => undefined,
		});
		assert.equal(first.startupKind, StartupKind.NewWindow);
		first.onWillShutdown(event => event.join(firstServices.get(IStorageService).flush(WillSaveStateReason.SHUTDOWN), 'storage'));
		await first.shutdown(reason);
		first.dispose();
		using nextServices = createLifecycleServices(browser);
		using next = nextServices.createInstance(BrowserLifecycleService, {
			ownerWindow: browser.window as unknown as Window,
			onError: () => undefined,
		});
		assert.equal(next.startupKind, expected);
		assert.equal(nextServices.get(IStorageService).get('lifecycle.lastShutdownReason', StorageScope.WORKSPACE), undefined);
		using thirdServices = createLifecycleServices(browser);
		using third = thirdServices.createInstance(BrowserLifecycleService, {
			ownerWindow: browser.window as unknown as Window,
			onError: () => undefined,
		});
		assert.equal(third.startupKind, StartupKind.NewWindow);
		browser.window.close();
	});
}

test('browser reload detection takes precedence over the previous shutdown reason', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser, 'reload');
	services.get(IStorageService).store('lifecycle.lastShutdownReason', 'load', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	assert.equal(lifecycle.startupKind, StartupKind.ReloadedWindow);
	browser.window.close();
});

test('a failed shutdown clears its persisted reason and can retry with another reason', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: () => undefined,
	});
	const storage = services.get(IStorageService);
	let fail = true;
	lifecycle.onWillShutdown(event => {
		event.join(storage.flush(WillSaveStateReason.SHUTDOWN), 'storage');
		if (fail) event.join(Promise.reject(new Error('backup failed')), 'backup');
	});
	await assert.rejects(lifecycle.shutdown('reload'), /shutdown participants failed/);
	assert.deepEqual(
		{
			willShutdown: lifecycle.willShutdown,
			reason: storage.get('lifecycle.lastShutdownReason', StorageScope.WORKSPACE),
		},
		{ willShutdown: false, reason: undefined },
	);
	fail = false;
	await lifecycle.shutdown('quit');
	assert.equal(storage.get('lifecycle.lastShutdownReason', StorageScope.WORKSPACE), 'quit');
	browser.window.close();
});

test('the browser renderer requires registered lifecycle dependencies at construction', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = new InstantiationService();
	const options = { ownerWindow: browser.window as unknown as Window, onError: () => undefined };
	assert.throws(() => services.createInstance(BrowserLifecycleService, options), /logService/);
	services.registerInstance(ILogService, new NullLoggerService());
	assert.throws(() => services.createInstance(BrowserLifecycleService, options), /storageService/);
	browser.window.close();
});

test('shutdown final callbacks run after all ordinary joins settle and retain every failure', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createLifecycleServices(browser);
		using lifecycle = services.createInstance(BrowserLifecycleService, {
			ownerWindow: browser.window as unknown as Window,
			onError: () => undefined,
		});
		const ordinary = new DeferredPromise<void>();
		const failure = new Error('ordinary join failed');
		const finalFailure = new Error('final join failed');
		const events: string[] = [];
		lifecycle.onWillShutdown(event => {
			event.join(ordinary.p, 'ordinary');
			event.join(async () => {
				events.push('final');
				throw finalFailure;
			}, 'final backup');
		});
		const shutdown = lifecycle.shutdown('windowClose');
		const rejected = assert.rejects(shutdown, error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0].cause === failure && error.errors[1].cause === finalFailure);
		assert.deepEqual(events, []);
		await ordinary.error(failure);
		await rejected;
		assert.deepEqual(events, ['final']);
	} finally {
		browser.window.close();
	}
});

test('overall shutdown failure resets state after every final join and permits repeated attempts', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createLifecycleServices(browser);
		using lifecycle = services.createInstance(BrowserLifecycleService, {
			ownerWindow: browser.window as unknown as Window,
			onError: () => undefined,
		});
		const final = new DeferredPromise<void>();
		const finalStarted = new DeferredPromise<void>();
		const events: string[] = [];
		let attempt = 0;
		lifecycle.onDidShutdownError(reason => {
			assert.equal(lifecycle.willShutdown, false);
			events.push(`failed:${reason}`);
		});
		lifecycle.onDidShutdown(reason => events.push(`completed:${reason}`));
		lifecycle.onWillShutdown(event => {
			attempt++;
			event.join(attempt < 3 ? Promise.reject(new Error('join failed')) : Promise.resolve(), 'ordinary');
			if (attempt === 1)
				event.join(() => {
					void finalStarted.complete(undefined);
					return final.p;
				}, 'delayed final');
		});
		const first = lifecycle.shutdown('windowClose');
		const rejected = assert.rejects(first, /shutdown participants failed/);
		await finalStarted.p;
		assert.deepEqual({ events, willShutdown: lifecycle.willShutdown }, { events: [], willShutdown: true });
		assert.equal(lifecycle.shutdown('reload'), first);
		await final.complete(undefined);
		await rejected;
		await assert.rejects(lifecycle.shutdown('reload'), /shutdown participants failed/);
		await lifecycle.shutdown('quit');
		assert.deepEqual(events, ['failed:windowClose', 'failed:reload', 'completed:quit']);
	} finally {
		browser.window.close();
	}
});

test('shutdown final callbacks recapture stale state before publishing overall success', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createLifecycleServices(browser);
		using lifecycle = services.createInstance(BrowserLifecycleService, {
			ownerWindow: browser.window as unknown as Window,
			onError: () => undefined,
		});
		let generation = 0;
		let captured = -1;
		let captures = 0;
		const completed: number[] = [];
		lifecycle.onWillShutdown(event =>
			event.join(
				() => {
					captured = generation;
					captures++;
					const write = Promise.resolve();
					if (captures === 1)
						void write.then(() => {
							generation++;
						});
					return write;
				},
				'final backup',
				() => captured === generation,
			),
		);
		lifecycle.onDidShutdown(() => completed.push(captured));
		await lifecycle.shutdown('quit');
		assert.deepEqual({ captured, generation, captures, completed }, { captured: 1, generation: 1, captures: 2, completed: [1] });
	} finally {
		browser.window.close();
	}
});

function createLifecycleServices(browser: JSDOM, navigationType = 'navigate'): InstantiationService {
	browser.reconfigure({ url: 'https://ash.test/' });
	Object.defineProperty(browser.window.performance, 'getEntriesByType', {
		configurable: true,
		value: () => [{ type: navigationType }],
	});
	const services = new InstantiationService();
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(
		IStorageService,
		() =>
			new BrowserStorageService({
				ownerWindow: browser.window as unknown as Window,
				workspaceId: 'workspace',
				flushInterval: 0,
			}),
	);
	return services;
}

for (const reason of ['windowClose', 'load'] as const) {
	test(`Electron keeps a slow ${reason} sealed and accepts its original token after a timeout`, async () => {
		const fixture = await createElectronLifecycleFixture();
		try {
			const ordinary = new DeferredPromise<void>();
			const entered = new DeferredPromise<void>();
			let shutdowns = 0;
			fixture.lifecycle.onWillShutdown(event => {
				shutdowns++;
				event.join(ordinary.p, 'held ordinary join');
				void entered.complete();
			});
			const first = fixture.request(reason);
			await entered.p;
			assert.equal(fixture.browser.window.document.body.inert, true);
			fixture.expireRequestDeadline();
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(
				fixture.responses.map(response => response.kind),
				['ready'],
			);
			assert.equal(fixture.window.isDestroyed(), false);
			await ordinary.complete();
			await fixture.firstCompletion.p;
			if (first) assert.equal(await first, true);
			assert.deepEqual(
				{
					inert: fixture.browser.window.document.body.inert,
					willShutdown: fixture.lifecycle.willShutdown,
					responses: fixture.responses.map(response => response.kind),
					errors: fixture.errors,
					shutdowns,
					committed: fixture.committed,
					destroyed: fixture.window.isDestroyed(),
				},
				{
					inert: true,
					willShutdown: true,
					responses: ['ready', 'complete'],
					errors: [],
					shutdowns: 1,
					committed: 1,
					destroyed: reason === 'windowClose',
				},
			);
		} finally {
			fixture.dispose();
		}
	});
}

test('Electron reports completion IPC rejection accurately and keeps the committed renderer sealed', async () => {
	const failure = new Error('Injected completion transport failure');
	const fixture = await createElectronLifecycleFixture(failure);
	try {
		let shutdowns = 0;
		fixture.lifecycle.onWillShutdown(() => {
			shutdowns++;
		});
		fixture.request('windowClose');
		await fixture.firstError.p;
		assert.deepEqual(
			{
				inert: fixture.browser.window.document.body.inert,
				committed: fixture.committed,
				responses: fixture.responses.map(response => response.kind),
				errors: fixture.errors,
			},
			{
				inert: true,
				committed: 1,
				responses: ['ready', 'complete'],
				errors: ['Failed to complete window close request Injected completion transport failure'],
			},
		);
		// The failed transport left Main waiting. A repeated close must not unseal
		// the committed renderer or start another shutdown while recovery is offered.
		fixture.expireRequestDeadline();
		await new Promise(resolve => setImmediate(resolve));
		fixture.request('windowClose');
		assert.deepEqual(
			{
				shutdowns,
				committed: fixture.committed,
				destroyed: fixture.window.isDestroyed(),
				recoveries: fixture.recoveries.length,
				responses: fixture.responses.map(response => response.kind),
			},
			{
				shutdowns: 1,
				committed: 1,
				destroyed: false,
				recoveries: 1,
				responses: ['ready', 'complete'],
			},
		);
	} finally {
		fixture.dispose();
	}
});

test('Electron restores editing only when shutdown itself fails and permits a later close', async () => {
	const fixture = await createElectronLifecycleFixture();
	try {
		let attempts = 0;
		fixture.lifecycle.onWillShutdown(event => event.join(++attempts === 1 ? Promise.reject(new Error('Injected backup failure')) : Promise.resolve(), 'backup'));
		fixture.request('windowClose');
		await fixture.failedResponse.p;
		assert.deepEqual(
			{
				inert: fixture.browser.window.document.body.inert,
				willShutdown: fixture.lifecycle.willShutdown,
				committed: fixture.committed,
				responses: fixture.responses.map(response => response.kind),
			},
			{
				inert: false,
				willShutdown: false,
				committed: 0,
				responses: ['ready', 'failed'],
			},
		);
		fixture.request('windowClose');
		await fixture.firstCompletion.p;
		assert.deepEqual({ attempts, committed: fixture.committed, destroyed: fixture.window.isDestroyed() }, { attempts: 2, committed: 1, destroyed: true });
		assert.equal(fixture.errors.length, 1);
		assert.match(fixture.errors[0]!, /^Failed to save window state before closing One or more shutdown participants failed$/u);
	} finally {
		fixture.dispose();
	}
});

let activeElectronIpc: ISandboxIpcRenderer | undefined;
const electronTestBridge: ISandboxIpcRenderer = {
	send: () => {
		throw new Error('Unexpected renderer send');
	},
	invoke: (channel, params) => activeElectronIpc!.invoke(channel, params),
	on: (channel, listener) => activeElectronIpc!.on(channel, listener),
};

class LifecycleTestWindow extends EventEmitter {
	private destroyed = false;
	readonly webContents: EventEmitter & { send(channel: string, token: number): void };
	constructor(deliver: (channel: string, token: number) => void) {
		super();
		this.webContents = Object.assign(new EventEmitter(), { send: deliver });
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	close(): void {
		let prevented = false;
		this.emit('close', {
			preventDefault() {
				prevented = true;
			},
		});
		if (!prevented) this.destroyed = true;
	}
}

async function createElectronLifecycleFixture(completionFailure?: Error) {
	const browser = new JSDOM('<!doctype html><body></body>');
	const services = createLifecycleServices(browser);
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
	const bridgeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	Object.defineProperty(globalThis, 'window', { configurable: true, value: browser.window });
	Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: browser.window.HTMLElement });
	Object.defineProperty(globalThis, 'ash', { configurable: true, value: { ipcRenderer: electronTestBridge } });
	const listeners = new Map<string, (value: unknown) => void>();
	const window = new LifecycleTestWindow((channel, token) => listeners.get(channel)?.(token));
	const reports: string[] = [];
	const recoveries: AbortSignal[] = [];
	const main = new LifecycleMainService(
		(_, failure) => {
			if (failure.kind === 'failed') reports.push(failure.message);
			else recoveries.push(failure.signal);
		},
		() => {},
		{
			getItem: () => undefined,
			setItem: () => {},
			removeItem: () => {},
			flush: async () => {},
			close: async () => {},
		},
		'test',
	);
	const registration = main.registerWindow(window);
	const route = windowCloseResponseIpcRoute(main, window);
	const responses: WindowCloseResponse[] = [];
	const errors: string[] = [];
	const firstError = new DeferredPromise<void>();
	const failedResponse = new DeferredPromise<void>();
	const firstCompletion = new DeferredPromise<void>();
	const originalSetTimeout = globalThis.setTimeout;
	const deadlines: Array<{ handle: ReturnType<typeof setTimeout>; fire(): void }> = [];
	// Advance only the main owner's 30-second close/load deadline, leaving Mocha and renderer timers intact.
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		const handle = originalSetTimeout(...args);
		const [callback, delay, ...parameters] = args;
		if (delay === 30_000)
			deadlines.push({
				handle,
				fire: () => {
					clearTimeout(handle);
					callback(...parameters);
				},
			});
		return handle;
	}) as typeof setTimeout;
	let completions = 0;
	activeElectronIpc = {
		send: electronTestBridge.send,
		on: (channel, listener) => {
			listeners.set(channel, listener);
			return {
				dispose: () => {
					listeners.delete(channel);
				},
			};
		},
		invoke: async (channel, params) => {
			assert.equal(channel, route.channel);
			const response = route.validate(params) as WindowCloseResponse;
			responses.push(response);
			if (response.kind === 'complete' && ++completions === 1 && completionFailure) throw completionFailure;
			const result = route.invoke(response);
			if (response.kind === 'failed') void failedResponse.complete();
			if (response.kind === 'complete') void firstCompletion.complete();
			return result;
		},
	};
	const originalConsoleError = console.error;
	console.error = (...values: unknown[]) => {
		errors.push(values.map(value => (value instanceof Error ? value.message : String(value))).join(' '));
		void firstError.complete();
	};
	const { ElectronLifecycleService } = await import('../../electron-browser/lifecycleService.js');
	const lifecycle = services.createInstance(ElectronLifecycleService, {
		ownerWindow: browser.window as unknown as Window,
		onError: (error: unknown) => errors.push(String(error)),
	});
	const fixture = {
		browser,
		lifecycle,
		window,
		reports,
		recoveries,
		responses,
		errors,
		firstError,
		failedResponse,
		firstCompletion,
		committed: 0,
		request: (reason: 'windowClose' | 'load') => (reason === 'load' ? main.unload(window) : window.close()),
		expireRequestDeadline: () => {
			const deadline = deadlines.shift();
			assert.ok(deadline, 'the main owner installed its close/load deadline');
			deadline.fire();
		},
		dispose: () => {
			globalThis.setTimeout = originalSetTimeout;
			for (const deadline of deadlines) clearTimeout(deadline.handle);
			console.error = originalConsoleError;
			lifecycle.dispose();
			registration.dispose();
			main.dispose();
			services.dispose();
			browser.window.close();
			activeElectronIpc = undefined;
			if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
			else Reflect.deleteProperty(globalThis, 'document');
			if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
			else Reflect.deleteProperty(globalThis, 'window');
			if (elementDescriptor) Object.defineProperty(globalThis, 'HTMLElement', elementDescriptor);
			else Reflect.deleteProperty(globalThis, 'HTMLElement');
			if (bridgeDescriptor) Object.defineProperty(globalThis, 'ash', bridgeDescriptor);
			else Reflect.deleteProperty(globalThis, 'ash');
		},
	};
	lifecycle.onDidShutdown(() => {
		fixture.committed++;
	});
	await lifecycle.initialize();
	return fixture;
}
