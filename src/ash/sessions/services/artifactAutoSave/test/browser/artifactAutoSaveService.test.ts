import { createTestArtifactCatalogService, createTestDocsService } from '../../../../test/common/testArtifactCatalogService.js';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { setup, suite, teardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { SaveReason, type ISaveOptions } from '../../../../../workbench/common/editor.js';
import { BrowserLifecycleService } from '../../../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { TestNotificationService } from '../../../../../workbench/services/notification/test/common/testNotificationService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { BrowserWorkingCopyService } from '../../../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { ArtifactAutoSaveService } from '../../browser/artifactAutoSaveService.js';
import { IArtifactCatalogService } from '../../../artifactCatalog/common/artifactCatalogService.js';

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	public readonly backupKind = 'text';
	public readonly backupLabel = 'Generated plan';
	private readonly contentChanged = this._register(new Emitter<void>());
	private readonly dirtyChanged = this._register(new Emitter<void>());
	private readonly externalChanged = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.contentChanged.event;
	public readonly onDidChangeDirty = this.dirtyChanged.event;
	public readonly onDidChangeExternalChange = this.externalChanged.event;
	private content = 'baseline';
	private savedContent = 'baseline';
	public hasExternalChange = false;
	public disk = 'baseline';
	public readonly attempts: { readonly content: string; readonly reason: SaveReason | undefined; readonly signal: AbortSignal; }[] = [];
	public readonly writes: string[] = [];
	/** Returning false simulates a working copy that acknowledges save without becoming clean. */
	public nextSave: (() => Promise<boolean | void>) | undefined;

	constructor(public readonly resource: URI) { super(); }

	public get isDirty(): boolean { return this.content !== this.savedContent; }
	public backup(): string { return this.content; }
	public restoreBackup(content: string): void {
		const wasDirty = this.isDirty;
		this.content = content;
		this.contentChanged.fire();
		if (wasDirty !== this.isDirty) this.dirtyChanged.fire();
	}

	public externalChange(content: string): void {
		this.disk = content;
		this.hasExternalChange = true;
		this.externalChanged.fire();
	}

	public async save(signal: AbortSignal, options?: ISaveOptions): Promise<void> {
		const content = this.content;
		this.attempts.push({ content, reason: options?.reason, signal });
		const next = this.nextSave;
		this.nextSave = undefined;
		if (await next?.() === false) return;
		signal.throwIfAborted();
		if (this.hasExternalChange) throw new Error('External write conflict');
		const wasDirty = this.isDirty;
		this.disk = content;
		this.savedContent = content;
		this.writes.push(content);
		if (wasDirty !== this.isDirty) this.dirtyChanged.fire();
	}

	public async saveAs(): Promise<void> { throw new Error('Unexpected saveAs'); }
	public async revert(): Promise<void> { throw new Error('Unexpected revert'); }
}

class Fixture extends Disposable {
	private readonly browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test/' });
	public readonly services: InstantiationService;
	public readonly workingCopies: BrowserWorkingCopyService;
	public readonly lifecycle: BrowserLifecycleService;
	public readonly notifications: TestNotificationService;
	public readonly generated = new Set<string>();
	private readonly catalogChangeEmitter = this._register(new Emitter<void>());

	constructor() {
		super();
		this._register(toDisposable(() => this.browser.window.close()));
		this.services = this._register(new TestUriIdentityServices());
		const ownerWindow = this.browser.window as unknown as Window;
		Object.defineProperty(ownerWindow.performance, 'getEntriesByType', { value: () => [] });
		this.services.registerInstance(ILogService, new NullLoggerService());
		this.services.registerInstance(IStorageService, this._register(this.services.createInstance(BrowserStorageService, { ownerWindow, workspaceId: 'generated-files', flushInterval: 0 })));
		this.lifecycle = this._register(this.services.createInstance(BrowserLifecycleService, { ownerWindow, onError: (error: unknown) => { throw error; } }));
		this.services.registerInstance(ILifecycleService, this.lifecycle);
		this.workingCopies = this._register(this.services.createInstance(BrowserWorkingCopyService));
		this.services.registerInstance(IWorkingCopyService, this.workingCopies);
		this.notifications = this._register(new TestNotificationService());
		this.services.registerInstance(INotificationService, this.notifications);
		this.services.registerInstance(IArtifactCatalogService, {
			...createTestArtifactCatalogService(),
			onDidChange: this.catalogChangeEmitter.event,
			files: [], loading: false, error: undefined,
			refresh: async () => { },
			findBySource: () => undefined,
			hasResource: resource => this.generated.has(resource.toString()),
		});
	}

	public start(): ArtifactAutoSaveService { return this._register(this.services.createInstance(ArtifactAutoSaveService)); }

	public open(generated = true): { readonly copy: TestWorkingCopy; readonly registration: IDisposable; } {
		const copy = this._register(new TestWorkingCopy(URI.file(`/generated-files/${this.workingCopies.getAll().length}.md`)));
		if (generated) this.generated.add(copy.resource.toString());
		const registration = this._register(this.workingCopies.register(copy));
		return { copy, registration };
	}

	public catalogChanged(): void { this.catalogChangeEmitter.fire(); }
}

suite('ArtifactAutoSaveService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	setup(() => mock.timers.enable({ apis: ['setTimeout'] }));
	teardown(() => mock.timers.reset());

	const dependencies: readonly ServiceIdentifier<unknown>[] = [IArtifactCatalogService, IWorkingCopyService, ILifecycleService, ILogService, INotificationService];
	for (const missing of dependencies) {
		test(`requires the ${missing.description} registration during production construction`, () => {
			using fixture = new Fixture();
			using services = new InstantiationService();
			for (const dependency of dependencies) {
				if (dependency !== missing) services.registerInstance(dependency, fixture.services.get(dependency));
			}
			assert.throws(() => services.createInstance(ArtifactAutoSaveService), { message: `Unknown service: ${missing}` });
		});
	}

	test('explicit artifact scopes share one scheduler and the final close drains pending edits', async () => {
		using fixture = new Fixture();
		const autoSave = fixture.start();
		const { copy } = fixture.open(false);
		using first = autoSave.register(copy);
		using second = autoSave.register(copy);
		copy.restoreBackup('artifact edit');
		first.dispose();
		mock.timers.tick(300);
		await setImmediate();
		assert.deepEqual(copy.writes, ['artifact edit']);
		copy.restoreBackup('close before debounce');
		await autoSave.flush(copy.resource);
		assert.equal(copy.disk, 'close before debounce');
		second.dispose();
		copy.restoreBackup('ordinary file again');
		mock.timers.tick(300);
		await setImmediate();
		assert.deepEqual(copy.writes, ['artifact edit', 'close before debounce']);
	});

	test('an artifact that is also generated saves once and remains tracked after its editor scope ends', async () => {
		using fixture = new Fixture();
		const autoSave = fixture.start();
		const { copy } = fixture.open();
		using scope = autoSave.register(copy);
		copy.restoreBackup('shared generated artifact');
		mock.timers.tick(300);
		await setImmediate();
		assert.deepEqual(copy.writes, ['shared generated artifact']);
		scope.dispose();
		copy.restoreBackup('generated edit');
		await autoSave.flush(copy.resource);
		assert.equal(copy.disk, 'generated edit');
	});

	test('failed automatic saves expose a retry action that persists the retained edits', async () => {
		using fixture = new Fixture();
		const autoSave = fixture.start();
		const { copy } = fixture.open(false);
		using scope = autoSave.register(copy);
		copy.nextSave = async () => { throw new Error('Disk unavailable'); };
		copy.restoreBackup('retained artifact');
		mock.timers.tick(300);
		await setImmediate();
		assert.equal(copy.isDirty, true);
		const retry = fixture.notifications.model.getNotifications()[0].actions?.primary?.[0];
		assert.ok(retry);
		await retry.run();
		assert.equal(copy.disk, 'retained artifact');
		assert.equal(copy.isDirty, false);
		assert.equal(fixture.notifications.model.getNotifications().length, 0);
	});

	test('retiring a generated artifact scope never reattaches an unregistered working copy', async () => {
		using fixture = new Fixture();
		const autoSave = fixture.start();
		const { copy, registration } = fixture.open();
		using scope = autoSave.register(copy);
		copy.restoreBackup('retired edit');
		registration.dispose();
		scope.dispose();
		mock.timers.tick(300);
		await setImmediate();
		await autoSave.flush(copy.resource);
		assert.equal(copy.attempts.length, 0);
	});

	test('closing before debounce reports failures with retry and retains dirty content', async () => {
		using fixture = new Fixture();
		const autoSave = fixture.start();
		const { copy } = fixture.open(false);
		using scope = autoSave.register(copy);
		copy.nextSave = async () => { throw new Error('Write unavailable during close'); };
		copy.restoreBackup('close immediately');
		await assert.rejects(autoSave.flush(copy.resource), /Write unavailable/);
		assert.equal(copy.isDirty, true);
		const retry = fixture.notifications.model.getNotifications()[0].actions?.primary?.[0];
		assert.ok(retry);
		await retry.run();
		assert.equal(copy.disk, 'close immediately');
	});

	test('debounces edits and saves the latest content through the working copy with AUTO reason', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		copy.restoreBackup('first edit');
		mock.timers.tick(299);
		await setImmediate();
		assert.equal(copy.attempts.length, 0);
		copy.restoreBackup('latest edit');
		mock.timers.tick(299);
		await setImmediate();
		assert.equal(copy.attempts.length, 0);
		mock.timers.tick(1);
		await setImmediate();
		assert.deepEqual([copy.writes, copy.disk, copy.backup(), copy.isDirty], [['latest edit'], 'latest edit', 'latest edit', false]);
		assert.equal(copy.attempts[0].reason, SaveReason.AUTO);
		assert.equal(copy.attempts[0].signal.aborted, false);
		mock.timers.tick(30_000);
		await setImmediate();
		assert.equal(copy.attempts.length, 1);
		assert.equal(fixture.notifications.model.getNotifications().length, 0);
	});

	test('saves dirty copies already open before construction and those recognized by a later catalogue update', async () => {
		using fixture = new Fixture();
		const { copy: existing } = fixture.open();
		const { copy: discovered } = fixture.open(false);
		existing.restoreBackup('existing edit');
		discovered.restoreBackup('discovered edit');
		fixture.start();
		fixture.generated.add(discovered.resource.toString());
		fixture.catalogChanged();
		mock.timers.tick(300);
		await setImmediate();
		assert.deepEqual([existing.writes, discovered.writes, existing.isDirty, discovered.isDirty], [['existing edit'], ['discovered edit'], false, false]);
	});

	test('serializes edits during successive saves and shutdown waits for the latest snapshot', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		const first = new DeferredPromise<void>();
		const second = new DeferredPromise<void>();
		copy.nextSave = () => first.p;
		copy.restoreBackup('first snapshot');
		mock.timers.tick(300);
		await setImmediate();
		copy.nextSave = () => second.p;
		copy.restoreBackup('second snapshot');
		mock.timers.tick(300);
		await setImmediate();
		assert.equal(copy.attempts.length, 1);
		await first.complete();
		await setImmediate();
		assert.deepEqual(copy.attempts.map(attempt => attempt.content), ['first snapshot', 'second snapshot']);
		copy.restoreBackup('latest snapshot');
		let closed = false;
		const shutdown = fixture.lifecycle.shutdown('quit').then(() => { closed = true; });
		await setImmediate();
		assert.equal(closed, false);
		assert.equal(copy.attempts.length, 2);
		await second.complete();
		await shutdown;
		assert.deepEqual([copy.writes, copy.disk, copy.backup(), copy.isDirty, closed], [['first snapshot', 'second snapshot', 'latest snapshot'], 'latest snapshot', 'latest snapshot', false, true]);
		assert.ok(copy.attempts.every(attempt => attempt.reason === SaveReason.AUTO));
	});

	test('preserves external content and dirty edits without writing or retrying a known conflict', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		copy.restoreBackup('local edit');
		copy.externalChange('external content');
		mock.timers.tick(300);
		await setImmediate();
		mock.timers.tick(30_000);
		await setImmediate();
		assert.deepEqual([copy.writes, copy.attempts, copy.disk, copy.backup(), copy.isDirty], [[], [], 'external content', 'local edit', true]);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
		await assert.rejects(fixture.lifecycle.shutdown('quit'), /shutdown participants failed/u);
		assert.equal(fixture.lifecycle.willShutdown, false);
		assert.equal(copy.disk, 'external content');
	});

	test('does not retry or overwrite an external conflict discovered by an in-flight save', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		const pending = new DeferredPromise<void>();
		copy.nextSave = () => pending.p;
		copy.restoreBackup('local snapshot');
		mock.timers.tick(300);
		await setImmediate();
		copy.restoreBackup('newer local edit');
		copy.externalChange('external write during IO');
		await pending.complete();
		await setImmediate();
		mock.timers.tick(30_000);
		await setImmediate();
		assert.deepEqual([copy.attempts.length, copy.writes, copy.disk, copy.backup(), copy.isDirty], [1, [], 'external write during IO', 'newer local edit', true]);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
	});

	test('retains failed edits without a queued retry and retries when the user edits again', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		const pending = new DeferredPromise<void>();
		copy.nextSave = async () => { await pending.p; throw new Error('Injected write failure'); };
		copy.restoreBackup('failed snapshot');
		mock.timers.tick(300);
		await setImmediate();
		copy.restoreBackup('edit during failed IO');
		mock.timers.tick(100);
		await pending.complete();
		await setImmediate();
		mock.timers.tick(30_000);
		await setImmediate();
		assert.deepEqual([copy.attempts.length, copy.writes, copy.disk, copy.backup(), copy.isDirty], [1, [], 'baseline', 'edit during failed IO', true]);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
		copy.restoreBackup('retry edit');
		mock.timers.tick(300);
		await setImmediate();
		assert.deepEqual([copy.attempts.length, copy.writes, copy.disk, copy.isDirty], [2, ['retry edit'], 'retry edit', false]);
	});

	test('a save that leaves unchanged content dirty fails once instead of retrying forever', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		copy.nextSave = async () => false;
		copy.restoreBackup('unacknowledged edit');
		mock.timers.tick(300);
		await setImmediate();
		mock.timers.tick(30_000);
		await setImmediate();
		assert.deepEqual([copy.attempts.length, copy.writes, copy.disk, copy.isDirty], [1, [], 'baseline', true]);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
		copy.nextSave = async () => false;
		await assert.rejects(fixture.lifecycle.shutdown('quit'), /shutdown participants failed/u);
		assert.equal(copy.attempts.length, 2);
		assert.equal(fixture.lifecycle.willShutdown, false);
	});

	test('ignores non-generated working copies even when they remain dirty at shutdown', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open(false);
		copy.restoreBackup('ordinary document edit');
		mock.timers.tick(30_000);
		await setImmediate();
		await fixture.lifecycle.shutdown('quit');
		assert.deepEqual([copy.attempts, copy.disk, copy.backup(), copy.isDirty], [[], 'baseline', 'ordinary document edit', true]);
	});

	test('stops tracking files removed from the generated catalogue and unregister cancels debounce', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy: removed } = fixture.open();
		const { copy: unregistered, registration } = fixture.open();
		removed.restoreBackup('removed edit');
		unregistered.restoreBackup('unregistered edit');
		fixture.generated.delete(removed.resource.toString());
		fixture.catalogChanged();
		registration.dispose();
		mock.timers.tick(30_000);
		await setImmediate();
		assert.deepEqual([removed.attempts, unregistered.attempts, removed.isDirty, unregistered.isDirty], [[], [], true, true]);
	});

	test('shutdown flushes before debounce expires and waits for the working-copy write', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy } = fixture.open();
		const pending = new DeferredPromise<void>();
		copy.nextSave = () => pending.p;
		copy.restoreBackup('close before debounce');
		let closed = false;
		const shutdown = fixture.lifecycle.shutdown('windowClose').then(() => { closed = true; });
		await setImmediate();
		assert.deepEqual([copy.attempts.length, copy.disk, copy.isDirty, closed], [1, 'baseline', true, false]);
		mock.timers.tick(300);
		await setImmediate();
		assert.equal(copy.attempts.length, 1);
		await pending.complete();
		await shutdown;
		assert.deepEqual([copy.writes, copy.disk, copy.isDirty, closed], [['close before debounce'], 'close before debounce', false, true]);
	});

	test('shutdown joins a pending save even if its working copy unregisters during IO', async () => {
		using fixture = new Fixture();
		fixture.start();
		const { copy, registration } = fixture.open();
		const pending = new DeferredPromise<void>();
		copy.nextSave = () => pending.p;
		copy.restoreBackup('already saving');
		mock.timers.tick(300);
		await setImmediate();
		registration.dispose();
		let closed = false;
		const shutdown = fixture.lifecycle.shutdown('quit').then(() => { closed = true; });
		await setImmediate();
		assert.equal(closed, false);
		await pending.complete();
		await shutdown;
		assert.deepEqual([copy.writes, copy.isDirty, closed], [['already saving'], false, true]);
	});
});
