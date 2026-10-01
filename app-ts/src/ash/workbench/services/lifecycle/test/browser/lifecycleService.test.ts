import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserLifecycleService } from "../../browser/lifecycleService.js";
import { LifecyclePhase, StartupKind, ShutdownVetoError } from '../../common/lifecycle.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';

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
	using services = new ServiceContainer();
	const options = { ownerWindow: browser.window as unknown as Window, onError: () => undefined };
	assert.throws(() => services.createInstance(BrowserLifecycleService, options), /logService/);
	services.registerInstance(ILogService, new NullLoggerService());
	assert.throws(() => services.createInstance(BrowserLifecycleService, options), /storageService/);
	browser.window.close();
});

function createLifecycleServices(browser: JSDOM, navigationType = 'navigate'): ServiceContainer {
	browser.reconfigure({ url: 'https://ash.test/' });
	Object.defineProperty(browser.window.performance, 'getEntriesByType', { configurable: true, value: () => [{ type: navigationType }] });
	const services = new ServiceContainer();
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'lifecycle-test', workspaceId: 'workspace', flushInterval: 0 }));
	return services;
}
