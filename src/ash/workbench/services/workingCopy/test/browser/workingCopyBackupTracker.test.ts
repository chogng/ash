import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserLifecycleService } from "../../../lifecycle/browser/lifecycleService.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { ILogService, NullLoggerService } from "../../../../../platform/log/common/log.js";
import { IStorageService, WillSaveStateReason } from "../../../../../platform/storage/common/storage.js";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { Emitter } from "../../../../../base/common/event.js";
import { DeferredPromise } from "../../../../../base/common/async.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserWorkingCopyService } from "../../browser/browserWorkingCopyService.js";
import { WorkingCopyBackupTracker } from "../../browser/workingCopyBackupTracker.js";
import { IndexedDbWorkingCopyBackupService } from "../../browser/indexedDbWorkingCopyBackupService.js";
import { type IWorkingCopyBackupService, type WorkingCopyBackup } from "../../common/workingCopyBackupService.js";
import { type IWorkingCopy } from "../../common/workingCopyService.js";

test("working-copy backup tracker persists the latest dirty content and deletes clean backups", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	const backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	using copy = new TestWorkingCopy(URI.file("C:\\project\\main.ts"));
	using registration = workingCopies.register(copy);

	copy.change("first");
	copy.change("latest");
	ownerWindow.runTimers();
	await tracker.flush();
	assert.equal((await backups.list())[0]?.content, "latest");

	copy.markClean();
	ownerWindow.runTimers();
	await tracker.flush();
	assert.deepEqual(await backups.list(), []);
});

test("working-copy backup tracker removes a closed draft and keeps another open copy", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	const resource = URI.parse('untitled:/Untitled-1');
	using first = new TestWorkingCopy(resource);
	using second = new TestWorkingCopy(resource);
	const firstRegistration = workingCopies.register(first);
	const secondRegistration = workingCopies.register(second);
	try {
		first.change('first draft');
		second.change('second draft');
		await tracker.flush();

		firstRegistration.dispose();
		await tracker.flush();
		assert.equal((await backups.list())[0]?.content, 'second draft');

		secondRegistration.dispose();
		await tracker.flush();
		assert.deepEqual(await backups.list(), []);
	} finally {
		firstRegistration.dispose();
		secondRegistration.dispose();
	}
});

test('working-copy backup tracker keeps a dirty copy when another copy of the resource is clean', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	const resource = URI.file('C:\\project\\main.ts');
	using dirty = new TestWorkingCopy(resource);
	using clean = new TestWorkingCopy(resource);
	using dirtyRegistration = workingCopies.register(dirty);
	using cleanRegistration = workingCopies.register(clean);

	dirty.change('unsaved');
	ownerWindow.runTimers();
	await tracker.flush();
	assert.equal((await backups.list())[0]?.content, 'unsaved');

	clean.markClean();
	ownerWindow.runTimers();
	await tracker.flush();
	assert.equal((await backups.list())[0]?.content, 'unsaved');
});

test('working-copy backup tracker retains a crash backup while a clean editor opens for restoration', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	const resource = URI.file('C:\\project\\recovered.ts');
	await backups.store({ resource, kind: 'text', content: 'recovered', updatedAt: Date.now() });
	using copy = new TestWorkingCopy(resource);
	using registration = workingCopies.register(copy);

	ownerWindow.runTimers();
	await tracker.flush();
	assert.equal((await backups.list())[0]?.content, 'recovered');

	copy.restoreBackup('recovered');
	await tracker.flush();
	copy.markClean();
	await tracker.flush();
	assert.deepEqual(await backups.list(), []);
});

test('working-copy backup tracker retains content when a clean recovery editor fails and unregisters', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	const resource = URI.file('C:\\project\\recovery.ts');
	await backups.store({ resource, kind: 'text', content: 'still needs recovery', updatedAt: 1 });
	using copy = new TestWorkingCopy(resource);
	const registration = workingCopies.register(copy);
	registration.dispose();
	await tracker.flush();
	assert.equal((await backups.list())[0]?.content, 'still needs recovery');
});

test('working-copy backup shutdown drains before editor unregister and database close', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using owner = new DisposableStore();
	const database = new ClosingDatabase();
	const backups = owner.add(new IndexedDbWorkingCopyBackupService('shutdown-test', database.factory));
	const errors: unknown[] = [];
	const tracker = owner.add(new WorkingCopyBackupTracker(workingCopies, backups, new TestWindow() as unknown as Window, error => errors.push(error)));
	using copy = new TestWorkingCopy(URI.file('/shutdown/settings.json'));
	const registration = workingCopies.register(copy);
	owner.add(toDisposable(() => { database.events.push('editor.dispose'); registration.dispose(); }));
	copy.change('23');
	await tracker.flush();
	copy.markClean();
	await tracker.flush();
	database.events.length = 0;

	await tracker.shutdown();
	tracker.completeShutdown();
	owner.dispose();
	const drainError = await tracker.flush().then(() => undefined, error => error as Error);
	assert.deepEqual({ events: database.events, errors: errors.map(error => (error as Error).name), drainError: drainError?.name }, {
		events: ['editor.dispose', 'database.close'], errors: [], drainError: undefined,
	});
});

test('working-copy backup shutdown retains edits made while final writes are pending', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new ControlledBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	using copy = new TestWorkingCopy(URI.file('/shutdown/dirty.ts'));
	using registration = workingCopies.register(copy);
	const firstWrite = backups.holdNext('store');
	copy.change('first');
	ownerWindow.runTimers();
	await firstWrite.entered.p;
	copy.change('final');
	const staleTimers = ownerWindow.snapshotTimers();
	const captured = new DeferredPromise<void>();
	copy.duringBackup = () => { void captured.complete(undefined); };
	const shutdown = tracker.shutdown();
	let settled = false;
	void shutdown.then(() => { settled = true; });
	assert.equal(tracker.shutdown(), shutdown);
	assert.equal(tracker.flush(), shutdown);
	await captured.p;
	copy.change('late');
	for (const callback of staleTimers) callback();
	assert.deepEqual({ settled, timers: ownerWindow.pendingTimers, calls: backups.calls }, { settled: false, timers: 0, calls: ['store:first'] });
	await firstWrite.release.complete(undefined);
	await shutdown;
	tracker.completeShutdown();
	tracker.completeShutdown();
	tracker.dispose();
	tracker.dispose();
	assert.equal(tracker.shutdown(), shutdown);
	assert.deepEqual({ content: (await backups.list()).map(backup => backup.content), calls: backups.calls }, { content: ['late'], calls: ['store:first', 'store:final', 'store:late'] });
});

test('working-copy backup shutdown captures synchronous edits reentered from backup', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, new TestWindow() as unknown as Window);
	using copy = new TestWorkingCopy(URI.file('/shutdown/reentrant.ts'));
	using registration = workingCopies.register(copy);
	copy.change('captured');
	copy.duringBackup = () => copy.change('reentrant edit');
	await tracker.shutdown();
	assert.deepEqual((await backups.list()).map(backup => backup.content), ['reentrant edit']);
});

test('working-copy backup shutdown awaits an in-flight clean delete', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new ControlledBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	using copy = new TestWorkingCopy(URI.file('/shutdown/clean.ts'));
	using registration = workingCopies.register(copy);
	copy.change('saved');
	await tracker.flush();
	const deletion = backups.holdNext('delete');
	copy.markClean();
	ownerWindow.runTimers();
	await deletion.entered.p;
	const shutdown = tracker.shutdown();
	let settled = false;
	void shutdown.then(() => { settled = true; });
	assert.equal(settled, false);
	await deletion.release.complete(undefined);
	await shutdown;
	tracker.completeShutdown();
	registration.dispose();
	assert.deepEqual({ backups: await backups.list(), calls: backups.calls }, { backups: [], calls: ['store:saved', 'delete'] });
});

test('working-copy backup shutdown completes pending clean timers and retains untouched recovery content', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	using saved = new TestWorkingCopy(URI.file('/shutdown/saved.ts'));
	using recovery = new TestWorkingCopy(URI.file('/shutdown/recovery.ts'));
	using savedRegistration = workingCopies.register(saved);
	using recoveryRegistration = workingCopies.register(recovery);
	await backups.store({ resource: recovery.resource, kind: 'text', content: 'unrestored crash content', updatedAt: 1 });
	saved.change('saved');
	await tracker.flush();
	saved.markClean();
	assert.equal(ownerWindow.pendingTimers, 1);
	await tracker.shutdown();
	assert.deepEqual({ contents: (await backups.list()).map(backup => backup.content), timers: ownerWindow.pendingTimers }, { contents: ['unrestored crash content'], timers: 0 });
});

for (const operation of ['store', 'delete'] as const) {
	test(`working-copy backup shutdown propagates in-flight ${operation} failure after all final writes settle`, async () => {
		using workingCopies = new BrowserWorkingCopyService();
		using backups = new ControlledBackups();
		const ownerWindow = new TestWindow();
		const failureObserved = new DeferredPromise<unknown>();
		using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window, error => { void failureObserved.complete(error); });
		using failing = new TestWorkingCopy(URI.file('/shutdown/failing.ts'));
		using pending = new TestWorkingCopy(URI.file('/shutdown/pending.ts'));
		using failingRegistration = workingCopies.register(failing);
		using pendingRegistration = workingCopies.register(pending);
		if (operation === 'delete') { failing.change('saved'); await tracker.flush(); }
		const failedOperation = backups.holdNext(operation);
		if (operation === 'delete') failing.markClean(); else failing.change('failed content');
		ownerWindow.runTimers();
		await failedOperation.entered.p;
		const pendingWrite = backups.holdNext('store');
		pending.change('must survive');
		ownerWindow.runTimers();
		await pendingWrite.entered.p;
		const error = new Error(`Injected ${operation} failure`);
		let settled = false;
		const shutdown = tracker.shutdown();
		const rejection = assert.rejects(shutdown.finally(() => { settled = true; }), value => value instanceof AggregateError && value.errors.includes(error));
		await failedOperation.release.error(error);
		assert.equal(await failureObserved.p, error);
		assert.equal(settled, false);
		await pendingWrite.release.complete(undefined);
		await rejection;
		assert.equal(tracker.shutdown(), shutdown);
		assert.equal((await backups.list()).find(backup => backup.resource.toString() === pending.resource.toString())?.content, 'must survive');
	});
}

for (const failingJoin of ['backup', 'storage', 'other'] as const) {
	test(`working-copy backups resume editing and retry after the overall ${failingJoin} join fails`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test/' });
		try {
			Object.defineProperty(browser.window.performance, 'getEntriesByType', { value: () => [] });
			using services = new InstantiationService();
			services.registerInstance(ILogService, new NullLoggerService());
			services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'backup-retry', flushInterval: 0 }));
			using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
			using workingCopies = new BrowserWorkingCopyService();
			using backups = new ControlledBackups();
			const ownerWindow = new TestWindow();
			const errors: unknown[] = [];
			using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window, error => errors.push(error));
			using copy = new TestWorkingCopy(URI.file('/shutdown/retry.ts'));
			using registration = workingCopies.register(copy);
			copy.change('last durable');
			await tracker.flush();
			const events: string[] = [];
			let shouldFail = true;
			const pendingJoin = new DeferredPromise<void>();
			const failedStore = failingJoin === 'backup' ? backups.holdNext('store') : undefined;
			const failure = new Error(`Injected ${failingJoin} join failure`);
			lifecycle.onDidShutdownError(() => {
				events.push('overall failure');
				tracker.cancelShutdown();
			});
			lifecycle.onDidShutdown(() => { events.push('completed'); tracker.completeShutdown(); });
			lifecycle.onWillShutdown(event => {
				event.join(tracker.shutdown().then(() => { events.push('backup drained'); }), 'backup');
				if (shouldFail) {
					const operation = failingJoin === 'storage' ? services.get(IStorageService).flush(WillSaveStateReason.SHUTDOWN).then(() => pendingJoin.p) : pendingJoin.p;
					event.join(operation, failingJoin === 'backup' ? 'pending other join' : failingJoin);
				}
			});
			copy.change('attempt content');
			const first = lifecycle.shutdown('windowClose');
			assert.equal(lifecycle.shutdown('quit'), first);
			const rejection = assert.rejects(first, /shutdown participants failed/);
			if (failedStore) {
				await failedStore.entered.p;
				await failedStore.release.error(failure);
			} else {
				await tracker.shutdown();
			}
			copy.change('while another join waits');
			assert.deepEqual({ events: events.filter(event => event === 'overall failure'), timers: ownerWindow.pendingTimers }, { events: [], timers: 0 });
			if (failedStore) {
				assert.equal((await backups.list())[0]?.content, 'last durable');
				await pendingJoin.complete(undefined);
			} else {
				await pendingJoin.error(failure);
			}
			await rejection;
			copy.change('after cancelled close');
			ownerWindow.runTimers();
			const flushError = await tracker.flush().then(() => undefined, error => error);
			assert.deepEqual({ events: events.filter(event => event === 'overall failure'), flushError, content: (await backups.list())[0]?.content, willShutdown: lifecycle.willShutdown }, {
				events: ['overall failure'], flushError: undefined, content: 'after cancelled close', willShutdown: false,
			});
			shouldFail = false;
			await lifecycle.shutdown('windowClose');
			assert.equal(events.at(-1), 'completed');
			assert.deepEqual(errors, []);
		} finally {
			browser.window.close();
		}
	});
}

test('working-copy backup cancellation is idempotent and retracks the current registry', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new ControlledBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	using closed = new TestWorkingCopy(URI.file('/shutdown/closed.ts'));
	using added = new TestWorkingCopy(URI.file('/shutdown/added.ts'));
	const closedRegistration = workingCopies.register(closed);
	try {
		closed.change('closed draft');
		await tracker.shutdown();
		closedRegistration.dispose();
		added.change('new draft');
		using addedRegistration = workingCopies.register(added);
		tracker.cancelShutdown();
		tracker.cancelShutdown();
		await tracker.flush();
		assert.deepEqual((await backups.list()).map(backup => backup.content), ['new draft']);
		const second = tracker.shutdown();
		assert.equal(tracker.shutdown(), second);
		await second;
	} finally {
		closedRegistration.dispose();
	}
});

test('final backup join captures edits through the overall result and stops producers only on success', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test/' });
	try {
		Object.defineProperty(browser.window.performance, 'getEntriesByType', { value: () => [] });
		using services = new InstantiationService();
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'final-backup', flushInterval: 0 }));
		using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		using workingCopies = new BrowserWorkingCopyService();
		using backups = new ControlledBackups();
		const ownerWindow = new TestWindow();
		using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
		using copy = new TestWorkingCopy(URI.file('/shutdown/final.ts'));
		using registration = workingCopies.register(copy);
		copy.change('before checks');
		const joined = new DeferredPromise<void>();
		const otherJoin = new DeferredPromise<void>();
		lifecycle.onBeforeShutdown(event => event.veto(tracker.flush().then(() => false), 'backup check'));
		lifecycle.onWillShutdown(event => {
			event.join(services.get(IStorageService).flush(WillSaveStateReason.SHUTDOWN), 'storage');
			event.join(otherJoin.p, 'other');
			event.join(() => tracker.shutdown(), 'final backups', () => tracker.isShutdownCurrent);
			void joined.complete(undefined);
		});
		lifecycle.onDidShutdown(() => tracker.completeShutdown());
		lifecycle.onDidShutdownError(reason => { if (reason !== 'pageHide') tracker.cancelShutdown(); });
		const shutdown = lifecycle.shutdown('windowClose');
		await joined.p;
		copy.change('during other join');
		const finalWrite = backups.holdNext('store');
		copy.duringBackup = () => { void tracker.shutdown().then(() => copy.change('after backup drain before outcome')); };
		await otherJoin.complete(undefined);
		await finalWrite.entered.p;
		copy.change('during final write');
		await finalWrite.release.complete(undefined);
		await shutdown;
		copy.change('after completed close');
		ownerWindow.runTimers();
		await tracker.flush();
		assert.deepEqual({ content: (await backups.list()).map(backup => backup.content), calls: backups.calls, timers: ownerWindow.pendingTimers }, {
			content: ['after backup drain before outcome'], calls: ['store:before checks', 'store:during other join', 'store:during final write', 'store:after backup drain before outcome'], timers: 0,
		});
	} finally {
		browser.window.close();
	}
});

test('failed backup capture preserves durable content and repeated cancellation permits a fresh shutdown', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, new TestWindow() as unknown as Window);
	using copy = new TestWorkingCopy(URI.file('/shutdown/capture-error.ts'));
	using registration = workingCopies.register(copy);
	copy.change('last valid snapshot');
	await tracker.flush();
	copy.change('failed capture');
	const error = new Error('Injected serialization failure');
	copy.duringBackup = () => { throw error; };
	const failed = tracker.shutdown();
	assert.equal(tracker.shutdown(), failed);
	await assert.rejects(failed, value => value instanceof AggregateError && value.errors.includes(error));
	assert.deepEqual((await backups.list()).map(backup => backup.content), ['last valid snapshot']);
	tracker.cancelShutdown();
	tracker.cancelShutdown();
	copy.change('retry content');
	await tracker.flush();
	const retried = tracker.shutdown();
	assert.notEqual(retried, failed);
	assert.equal(tracker.shutdown(), retried);
	await retried;
	tracker.completeShutdown();
	assert.deepEqual((await backups.list()).map(backup => backup.content), ['retry content']);
});

test('backup shutdown retains the existing last registered dirty copy for a shared resource', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using backups = new MemoryBackups();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, new TestWindow() as unknown as Window);
	const resource = URI.file('/shutdown/shared.ts');
	using first = new TestWorkingCopy(resource);
	using second = new TestWorkingCopy(resource);
	using firstRegistration = workingCopies.register(first);
	using secondRegistration = workingCopies.register(second);
	first.change('first copy');
	second.change('second copy');
	await tracker.flush();
	assert.deepEqual((await backups.list()).map(backup => backup.content), ['second copy']);
	await tracker.shutdown();
	tracker.completeShutdown();
	assert.deepEqual((await backups.list()).map(backup => backup.content), ['second copy']);
});

test('failed pagehide drains before forced host disposal without restarting database operations', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test/' });
	try {
		Object.defineProperty(browser.window.performance, 'getEntriesByType', { value: () => [] });
		using services = new InstantiationService();
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'forced-pagehide', flushInterval: 0 }));
		using lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: browser.window as unknown as Window, onError: () => undefined });
		using workingCopies = new BrowserWorkingCopyService();
		using owner = new DisposableStore();
		const database = new ClosingDatabase();
		const backups = owner.add(new IndexedDbWorkingCopyBackupService('forced-pagehide', database.factory));
		const errors: unknown[] = [];
		const tracker = owner.add(new WorkingCopyBackupTracker(workingCopies, backups, new TestWindow() as unknown as Window, error => errors.push(error)));
		using copy = new TestWorkingCopy(URI.file('/shutdown/pagehide.ts'));
		const registration = workingCopies.register(copy);
		owner.add(toDisposable(() => { database.events.push('editor.dispose'); registration.dispose(); }));
		copy.change('durable despite another failure');
		lifecycle.onWillShutdown(event => {
			event.join(Promise.reject(new Error('Injected other join failure')), 'other');
			event.join(() => tracker.shutdown(), 'final backup', () => tracker.isShutdownCurrent);
		});
		lifecycle.onDidShutdown(() => tracker.completeShutdown());
		lifecycle.onDidShutdownError(reason => { if (reason !== 'pageHide') tracker.cancelShutdown(); });
		const shutdown = lifecycle.shutdown('pageHide').finally(() => owner.dispose());
		await assert.rejects(shutdown, /shutdown participants failed/);
		await tracker.flush();
		assert.deepEqual({ events: database.events, errors, contents: [...database.records.values()].map(record => record.content) }, {
			events: ['transaction', 'editor.dispose', 'database.close'], errors: [], contents: ['durable despite another failure'],
		});
	} finally {
		browser.window.close();
	}
});

/** Exercises the real backup service's await-database/transaction/close boundary without persistent data. */
class ClosingDatabase {
	readonly events: string[] = [];
	readonly records = new Map<string, { readonly key: string; readonly content: string; }>();
	private closing = false;
	readonly factory = {
		open: () => {
			const opening: { result: unknown; onsuccess?: () => void; } = {
				result: {
					close: () => { this.closing = true; this.events.push('database.close'); },
					transaction: () => {
						this.events.push(this.closing ? 'transaction.after-close' : 'transaction');
						if (this.closing) throw new DOMException('The database connection is closing.', 'InvalidStateError');
						const transaction: { oncomplete?: () => void; objectStore: () => unknown; } = {
							objectStore: () => ({
								put: (record: { readonly key: string; readonly content: string; }) => { this.records.set(record.key, record); queueMicrotask(() => transaction.oncomplete?.()); },
								delete: (key: string) => { this.records.delete(key); queueMicrotask(() => transaction.oncomplete?.()); },
							}),
						};
						return transaction;
					},
				}
			};
			queueMicrotask(() => opening.onsuccess?.());
			return opening;
		},
	} as unknown as IDBFactory;
}

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyChanges = this._register(new Emitter<void>());
	private readonly contentChanges = this._register(new Emitter<void>());
	readonly resource;
	readonly backupKind = "text" as const;
	readonly onDidChangeDirty = this.dirtyChanges.event;
	readonly onDidChangeContent = this.contentChanges.event;
	readonly onDidChangeExternalChange = () => ({ dispose() { }, [Symbol.dispose]() { } });
	isDirty = false;
	readonly hasExternalChange = false;
	private content = "";
	duringBackup: (() => void) | undefined;

	constructor(resource: URI) { super(); this.resource = resource; }
	change(content: string): void { this.content = content; const becameDirty = !this.isDirty; this.isDirty = true; this.contentChanges.fire(); if (becameDirty) this.dirtyChanges.fire(); }
	markClean(): void { this.isDirty = false; this.dirtyChanges.fire(); }
	backup(): string { const content = this.content; const callback = this.duringBackup; this.duringBackup = undefined; callback?.(); return content; }
	restoreBackup(content: string): void { this.change(content); }
	async save(): Promise<void> { this.markClean(); }
	async saveAs(): Promise<void> { this.markClean(); }
	async revert(): Promise<void> { this.markClean(); }
}

class MemoryBackups extends Disposable implements IWorkingCopyBackupService {
	private readonly values = new Map<string, WorkingCopyBackup>();
	async list(): Promise<readonly WorkingCopyBackup[]> { return [...this.values.values()]; }
	async store(backup: WorkingCopyBackup): Promise<void> { this.values.set(backup.resource.toString(), backup); }
	async delete(resource: URI): Promise<void> { this.values.delete(resource.toString()); }
	switchWorkspace(): void { this.values.clear(); }
}

class ControlledBackups extends MemoryBackups {
	readonly calls: string[] = [];
	private readonly held: Array<{ kind: 'store' | 'delete'; entered: DeferredPromise<void>; release: DeferredPromise<void>; }> = [];

	holdNext(kind: 'store' | 'delete'): { entered: DeferredPromise<void>; release: DeferredPromise<void>; } {
		const block = { kind, entered: new DeferredPromise<void>(), release: new DeferredPromise<void>() };
		this.held.push(block);
		return block;
	}

	override async store(backup: WorkingCopyBackup): Promise<void> {
		this.calls.push(`store:${backup.content}`);
		await this.wait('store');
		await super.store(backup);
	}

	override async delete(resource: URI): Promise<void> {
		this.calls.push('delete');
		await this.wait('delete');
		await super.delete(resource);
	}

	private async wait(kind: 'store' | 'delete'): Promise<void> {
		const block = this.held[0];
		if (block?.kind !== kind) return;
		this.held.shift();
		await block.entered.complete(undefined);
		await block.release.p;
	}
}

class TestWindow {
	private nextTimer = 1;
	private readonly timers = new Map<number, () => void>();
	setTimeout(callback: () => void): number { const id = this.nextTimer++; this.timers.set(id, callback); return id; }
	clearTimeout(id: number): void { this.timers.delete(id); }
	get pendingTimers(): number { return this.timers.size; }
	snapshotTimers(): readonly (() => void)[] { return [...this.timers.values()]; }
	runTimers(): void { const callbacks = [...this.timers.values()]; this.timers.clear(); for (const callback of callbacks) callback(); }
}
