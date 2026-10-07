import assert from "node:assert/strict";
import { EventEmitter } from 'node:events';
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DeferredPromise } from "../../../../../base/common/async.js";
import { BrowserLifecycleService } from "../../browser/lifecycleService.js";
import { LifecyclePhase, StartupKind, ShutdownVetoError } from '../../common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { LifecycleMainService, windowCloseResponseIpcRoute } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import type { ISandboxIpcRenderer } from '../../../../../base/parts/sandbox/common/sandboxTypes.js';
import type { WindowCloseResponse } from '../../../../../platform/window/common/window.js';

test("BrowserLifecycleService joins participants once before completing shutdown", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const errors: unknown[] = [];
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: (error: unknown) => errors.push(error) });
	const events: string[] = [];
	lifecycle.onWillShutdown(event => {
		events.push(`will:${event.reason}`);
		event.join(Promise.resolve().then(() => { events.push("joined"); }), "test participant");
	});
	lifecycle.onDidShutdown(reason => events.push(`did:${reason}`));
	const first = lifecycle.shutdown("reload");
	assert.equal(lifecycle.shutdown("quit"), first);
	await first;
	assert.deepEqual(events, ["will:reload", "joined", "did:reload"]);
	assert.equal(lifecycle.willShutdown, true);
	assert.deepEqual(errors, []);
	browser.window.close();
});

test("BrowserLifecycleService reports pagehide participant failures", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const errors: unknown[] = [];
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: (error: unknown) => errors.push(error) });
	lifecycle.onWillShutdown(event => event.join(Promise.reject(new Error("flush failed")), "failing flush"));
	browser.window.dispatchEvent(new browser.window.PageTransitionEvent("pagehide"));
	await new Promise(resolve => globalThis.setTimeout(resolve, 0));
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /shutdown participants failed/iu);
	browser.window.close();
});

test("BrowserLifecycleService returns the same shutdown promise during onWillShutdown", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	let reentrant: Promise<void> | undefined;
	lifecycle.onWillShutdown(() => { reentrant = lifecycle.shutdown("quit"); });
	const initial = lifecycle.shutdown("reload");
	assert.equal(reentrant, initial);
	await initial;
	browser.window.close();
});

test('BrowserLifecycleService retries a failed shutdown without publishing completion', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
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
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
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
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
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
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	const milestones: LifecyclePhase[] = [];
	const ready = lifecycle.when(LifecyclePhase.Ready).then(() => milestones.push(LifecyclePhase.Ready));
	const restored = lifecycle.when(LifecyclePhase.Restored).then(() => milestones.push(LifecyclePhase.Restored));
	assert.equal(lifecycle.when(LifecyclePhase.Eventually), lifecycle.when(LifecyclePhase.Eventually));
	const eventually = lifecycle.when(LifecyclePhase.Eventually).then(() => milestones.push(LifecyclePhase.Eventually));
	lifecycle.phase = LifecyclePhase.Restored;
	await Promise.all([ready, restored]);
	assert.deepEqual(milestones, [LifecyclePhase.Ready, LifecyclePhase.Restored]);
	assert.throws(() => { lifecycle.phase = LifecyclePhase.Ready; }, /cannot go backwards/);
	lifecycle.phase = LifecyclePhase.Eventually;
	await eventually;
	await lifecycle.when(LifecyclePhase.Ready);
	assert.deepEqual(milestones, [LifecyclePhase.Ready, LifecyclePhase.Restored, LifecyclePhase.Eventually]);
	await lifecycle.shutdown('quit');
	assert.deepEqual({ phase: lifecycle.phase, willShutdown: lifecycle.willShutdown }, { phase: LifecyclePhase.Eventually, willShutdown: true });
	browser.window.close();
});

for (const [reason, expected] of [['reload', StartupKind.ReloadedWindow], ['load', StartupKind.ReopenedWindow], ['quit', StartupKind.NewWindow]] as const) {
	test(`window startup consumes the previous ${reason} shutdown exactly once`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		using firstServices = createLifecycleServices(browser);
		using first = firstServices.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		assert.equal(first.startupKind, StartupKind.NewWindow);
		first.onWillShutdown(event => event.join(firstServices.get(IStorageService).flush(WillSaveStateReason.SHUTDOWN), 'storage'));
		await first.shutdown(reason);
		first.dispose();
		using nextServices = createLifecycleServices(browser);
		using next = nextServices.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		assert.equal(next.startupKind, expected);
		assert.equal(nextServices.get(IStorageService).get('lifecycle.lastShutdownReason', StorageScope.WORKSPACE), undefined);
		using thirdServices = createLifecycleServices(browser);
		using third = thirdServices.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		assert.equal(third.startupKind, StartupKind.NewWindow);
		browser.window.close();
	});
}

test('browser reload detection takes precedence over the previous shutdown reason', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser, 'reload');
	services.get(IStorageService).store('lifecycle.lastShutdownReason', 'load', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	assert.equal(lifecycle.startupKind, StartupKind.ReloadedWindow);
	browser.window.close();
});

test('a failed shutdown clears its persisted reason and can retry with another reason', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using services = createLifecycleServices(browser);
	using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
	const storage = services.get(IStorageService);
	let fail = true;
	lifecycle.onWillShutdown(event => {
		event.join(storage.flush(WillSaveStateReason.SHUTDOWN), 'storage');
		if (fail) event.join(Promise.reject(new Error('backup failed')), 'backup');
	});
	await assert.rejects(lifecycle.shutdown('reload'), /shutdown participants failed/);
	assert.deepEqual({ willShutdown: lifecycle.willShutdown, reason: storage.get('lifecycle.lastShutdownReason', StorageScope.WORKSPACE) }, { willShutdown: false, reason: undefined });
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
		using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		const ordinary = new DeferredPromise<void>();
		const failure = new Error('ordinary join failed');
		const finalFailure = new Error('final join failed');
		const events: string[] = [];
		lifecycle.onWillShutdown(event => {
			event.join(ordinary.p, 'ordinary');
			event.join(async () => { events.push('final'); throw finalFailure; }, 'final backup');
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
		using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
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
			if (attempt === 1) event.join(() => { void finalStarted.complete(undefined); return final.p; }, 'delayed final');
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
		using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		let generation = 0;
		let captured = -1;
		let captures = 0;
		const completed: number[] = [];
		lifecycle.onWillShutdown(event => event.join(() => {
			captured = generation;
			captures++;
			const write = Promise.resolve();
			if (captures === 1) void write.then(() => { generation++; });
			return write;
		}, 'final backup', () => captured === generation));
		lifecycle.onDidShutdown(() => completed.push(captured));
		await lifecycle.shutdown('quit');
		assert.deepEqual({ captured, generation, captures, completed }, { captured: 1, generation: 1, captures: 2, completed: [1] });
	} finally {
		browser.window.close();
	}
});

function createLifecycleServices(browser: JSDOM, navigationType = 'navigate'): InstantiationService {
	browser.reconfigure({ url: 'https://ash.test/' });
	Object.defineProperty(browser.window.performance, 'getEntriesByType', { configurable: true, value: () => [{ type: navigationType }] });
	const services = new InstantiationService();
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'workspace', flushInterval: 0 }));
	return services;
}

for (const reason of ['windowClose', 'load'] as const) {
	test(`Electron keeps a committed ${reason} sealed after its token expires and accepts a new token`, async () => {
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
			if (first) assert.equal(await first, false);
			await ordinary.complete();
			await fixture.completionError.p;
			assert.deepEqual({
				inert: fixture.browser.window.document.body.inert, willShutdown: fixture.lifecycle.willShutdown,
				responses: fixture.responses.map(response => response.kind), errors: fixture.errors, destroyed: fixture.window.isDestroyed(),
			}, {
				inert: true, willShutdown: true, responses: ['ready', 'complete'],
				errors: ['Failed to complete window close request Window close request is no longer active'], destroyed: false,
			});
			const next = fixture.request(reason);
			await fixture.secondCompletion.p;
			if (next) assert.equal(await next, true);
			assert.deepEqual({ shutdowns, committed: fixture.committed, destroyed: fixture.window.isDestroyed() }, {
				shutdowns: 1, committed: 1, destroyed: reason === 'windowClose',
			});
			const completed = fixture.responses.filter(response => response.kind === 'complete');
			assert.equal(completed.length, 2);
			assert.notEqual(completed[0]!.token, completed[1]!.token);
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
		fixture.lifecycle.onWillShutdown(() => { shutdowns++; });
		fixture.request('windowClose');
		await fixture.firstError.p;
		assert.deepEqual({ inert: fixture.browser.window.document.body.inert, committed: fixture.committed, responses: fixture.responses.map(response => response.kind), errors: fixture.errors }, {
			inert: true, committed: 1, responses: ['ready', 'complete'], errors: ['Failed to complete window close request Injected completion transport failure'],
		});
		// The main owner retires the unanswered token; only a new user request may retry completion.
		fixture.expireRequestDeadline();
		fixture.request('windowClose');
		await fixture.secondCompletion.p;
		assert.deepEqual({ shutdowns, committed: fixture.committed, destroyed: fixture.window.isDestroyed() }, { shutdowns: 1, committed: 1, destroyed: true });
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
		assert.deepEqual({ inert: fixture.browser.window.document.body.inert, willShutdown: fixture.lifecycle.willShutdown, committed: fixture.committed, responses: fixture.responses.map(response => response.kind) }, {
			inert: false, willShutdown: false, committed: 0, responses: ['ready', 'failed'],
		});
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
	send: () => { throw new Error('Unexpected renderer send'); },
	invoke: (channel, params) => activeElectronIpc!.invoke(channel, params),
	on: (channel, listener) => activeElectronIpc!.on(channel, listener),
};

class LifecycleTestWindow extends EventEmitter {
	private destroyed = false;
	readonly webContents: EventEmitter & { send(channel: string, token: number): void; };
	constructor(deliver: (channel: string, token: number) => void) {
		super();
		this.webContents = Object.assign(new EventEmitter(), { send: deliver });
	}
	isDestroyed(): boolean { return this.destroyed; }
	close(): void {
		let prevented = false;
		this.emit('close', { preventDefault() { prevented = true; } });
		if (!prevented) this.destroyed = true;
	}
}

async function createElectronLifecycleFixture(completionFailure?: Error) {
	const browser = new JSDOM('<!doctype html><body></body>');
	const services = createLifecycleServices(browser);
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const bridgeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	Object.defineProperty(globalThis, 'ash', { configurable: true, value: { ipcRenderer: electronTestBridge } });
	const listeners = new Map<string, (value: unknown) => void>();
	const window = new LifecycleTestWindow((channel, token) => listeners.get(channel)?.(token));
	const reports: string[] = [];
	const main = new LifecycleMainService((_, message) => { reports.push(message); }, () => { }, {
		getItem: () => undefined, setItem: () => { }, removeItem: () => { }, flush: async () => { }, close: async () => { },
	}, 'test');
	const registration = main.registerWindow(window);
	const route = windowCloseResponseIpcRoute(main, window);
	const responses: WindowCloseResponse[] = [];
	const errors: string[] = [];
	const firstError = new DeferredPromise<void>();
	const completionError = new DeferredPromise<void>();
	const failedResponse = new DeferredPromise<void>();
	const firstCompletion = new DeferredPromise<void>();
	const secondCompletion = new DeferredPromise<void>();
	const originalSetTimeout = globalThis.setTimeout;
	const deadlines: Array<{ handle: ReturnType<typeof setTimeout>; fire(): void; }> = [];
	// Advance only the main owner's 30-second close/load deadline, leaving Mocha and renderer timers intact.
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		const handle = originalSetTimeout(...args);
		const [callback, delay, ...parameters] = args;
		if (delay === 30_000) deadlines.push({ handle, fire: () => { clearTimeout(handle); callback(...parameters); } });
		return handle;
	}) as typeof setTimeout;
	let completions = 0;
	activeElectronIpc = {
		send: electronTestBridge.send,
		on: (channel, listener) => { listeners.set(channel, listener); return { dispose: () => { listeners.delete(channel); } }; },
		invoke: async (channel, params) => {
			assert.equal(channel, route.channel);
			const response = route.validate(params) as WindowCloseResponse;
			responses.push(response);
			if (response.kind === 'complete' && ++completions === 1 && completionFailure) throw completionFailure;
			const result = route.invoke(response);
			if (response.kind === 'failed') void failedResponse.complete();
			if (response.kind === 'complete') void (completions === 1 ? firstCompletion : secondCompletion).complete();
			return result;
		},
	};
	const originalConsoleError = console.error;
	console.error = (...values: unknown[]) => {
		errors.push(values.map(value => value instanceof Error ? value.message : String(value)).join(' '));
		void firstError.complete();
		if (values[0] === 'Failed to complete window close request') void completionError.complete();
	};
	const { ElectronLifecycleService } = await import('../../electron-browser/lifecycleService.js');
	const lifecycle = services.createInstance(ElectronLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: (error: unknown) => errors.push(String(error)) });
	const fixture = {
		browser, lifecycle, window, reports, responses, errors, firstError, completionError, failedResponse, firstCompletion, secondCompletion, committed: 0,
		request: (reason: 'windowClose' | 'load') => reason === 'load' ? main.unload(window) : window.close(),
		expireRequestDeadline: () => {
			const deadline = deadlines.shift();
			assert.ok(deadline, 'the main owner installed its close/load deadline');
			deadline.fire();
		},
		dispose: () => {
			globalThis.setTimeout = originalSetTimeout;
			for (const deadline of deadlines) clearTimeout(deadline.handle);
			console.error = originalConsoleError;
			lifecycle.dispose(); registration.dispose(); main.dispose(); services.dispose(); browser.window.close();
			activeElectronIpc = undefined;
			if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
			if (bridgeDescriptor) Object.defineProperty(globalThis, 'ash', bridgeDescriptor); else Reflect.deleteProperty(globalThis, 'ash');
		},
	};
	lifecycle.onDidShutdown(() => { fixture.committed++; });
	await lifecycle.initialize();
	return fixture;
}
