import { registerTestTerminalLifecycleServices } from '../../../../test/browser/workbenchTestServices.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITerminalProcessService, type ITerminalProcessCloseOptions } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AbstractLifecycleService } from '../../../../services/lifecycle/common/lifecycleService.js';
import { ILifecycleService, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ITerminalService, ITerminalGroupService } from '../../../../services/terminal/browser/terminal.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TerminalGroupService } from '../../browser/terminalGroupService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { ShutdownVetoError } from '../../../../services/lifecycle/common/lifecycle.js';
import '../../common/terminalConfiguration.js';
import { BaseSecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { TerminalService } from '../../browser/terminalService.js';
import { TerminalNativeContribution } from '../../electron-browser/terminalNativeContribution.js';

// Only the host binding is replaced; final joins use the actual lifecycle coordinator.
class WindowLifecycle extends AbstractLifecycleService { }

function fixture(owner: DisposableStore, release: (id: string) => Promise<void>, settings: Record<string, unknown> = {}) {
	const browser = new JSDOM('', { url: 'https://terminal.test' });
	owner.add(toDisposable(() => browser.window.close()));
	const services = owner.add(new InstantiationService());
	const storage = owner.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'terminal', flushInterval: 0 }));
	const log = new NullLoggerService();
	const errors: unknown[] = [];
	log.error = (...args) => { errors.push(args); };
	services.registerInstance(ILogService, log);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IConfigurationService, owner.add(new TestConfigurationService({ source: JSON.stringify(settings) })));
	services.registerInstance(IWorkspaceContextService, owner.add(new TestWorkspaceService({ id: 'workspace', uri: URI.file('/workspace') })));
	let next = 0;
	const closes: string[] = [];
	const writes: string[] = [];
	services.registerInstance(ITerminalProcessService, {
		operatingSystem: OperatingSystem.Macintosh, onConnectionState: Event.None,
		getConnectionState: async () => 'ready',
		create: async () => ({ terminalId: `pty-${++next}`, ready: { pid: next, cwd: '/workspace' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'reconnectable' }),
		close: async ({ terminalId }: ITerminalProcessCloseOptions) => { closes.push(terminalId); await release(terminalId); },
		getProcessInfo: async () => ({ ready: { pid: 1, cwd: '/workspace' }, cwd: '/workspace', cols: 80, rows: 24, hasChildProcesses: true }),
		write: async ({ data }: { data: string; }) => { writes.push(data); },
	} as unknown as ITerminalProcessService);
	const lifecycle = owner.add(new WindowLifecycle(StartupKind.NewWindow, log, storage));
	services.registerInstance(ILifecycleService, lifecycle);
	registerTestTerminalLifecycleServices(services);
	const terminals = owner.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	services.registerInstance(IViewsService, { openView: async () => null } as unknown as IViewsService);
	services.registerInstance(ITerminalGroupService, owner.add(services.createInstance(TerminalGroupService)));
	const contribution = owner.add(services.createInstance(TerminalNativeContribution));
	const create = () => terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' }, deferStart: true });
	return { terminals, lifecycle, contribution, create, closes, errors, services, writes };
}

suite('Desktop terminal shutdown confirmation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('window credential stores isolate leases and discard them on disposal', async () => {
		using first = new BaseSecretStorageService();
		using second = new BaseSecretStorageService();
		await first.set('terminal.reload', 'opaque-lease');
		assert.equal(await second.get('terminal.reload'), undefined);
		assert.deepEqual(await first.keys(), ['terminal.reload']);
		first.dispose();
		await assert.rejects(first.get('terminal.reload'));
		assert.deepEqual(await second.keys(), []);
	});

	test('canceling a terminal close keeps stdin and the original process client usable', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { }, { 'terminal.integrated.confirmOnKill': 'always' });
		const instance = await scope.create();
		const answer = new DeferredPromise<{ confirmed: boolean; }>();
		scope.services.get(IDialogService).confirm = () => answer.p;
		const closing = scope.terminals.safeDisposeTerminal(instance);
		await instance.sendText('while-confirming', false);
		answer.complete({ confirmed: false });
		await closing;
		await instance.sendText('after-cancel', false);
		assert.deepEqual(scope.writes, ['while-confirming', 'after-cancel']);
		assert.deepEqual(scope.closes, []);
		assert.equal(scope.terminals.activeInstance, instance);
		scope.services.get(IDialogService).confirm = async () => ({ confirmed: true });
		await scope.terminals.safeDisposeTerminal(instance);
		assert.deepEqual(scope.closes, ['pty-1']);
	});

	test('canceling window close keeps every original instance and does not release a process', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { }, { 'terminal.integrated.confirmOnExit': 'always' });
		const first = await scope.create();
		const second = await scope.create();
		const answer = new DeferredPromise<{ confirmed: boolean; }>();
		scope.services.get(IDialogService).confirm = () => answer.p;
		const shutdown = scope.lifecycle.shutdown('windowClose');
		const canceled = assert.rejects(shutdown, ShutdownVetoError);
		assert.deepEqual(scope.closes, []);
		assert.deepEqual(scope.terminals.instances, [first, second]);
		answer.complete({ confirmed: false });
		await canceled;
		assert.equal(scope.lifecycle.willShutdown, false);
		assert.equal(scope.terminals.activeInstance, second);
		assert.deepEqual(scope.closes, []);
		scope.services.get(IDialogService).confirm = async () => ({ confirmed: true });
		await scope.lifecycle.shutdown('windowClose');
		assert.deepEqual(scope.closes, ['pty-1', 'pty-2']);
	});

	test('waits for process release and the final join catches an instance created while waiting', async () => {
		using owner = new DisposableStore();
		const gate = new DeferredPromise<void>();
		const scope = fixture(owner, id => id === 'pty-1' ? gate.p : Promise.resolve());
		await scope.create();
		let done = false;
		const shutdown = scope.lifecycle.shutdown('windowClose').then(() => { done = true; });
		for (let i = 0; i < 20 && !scope.closes.length; i++) await Promise.resolve();
		assert.deepEqual(scope.closes, ['pty-1']);
		assert.equal(done, false);
		await scope.create();
		gate.complete();
		await shutdown;
		assert.deepEqual(scope.closes, ['pty-1', 'pty-2']);
		assert.equal(scope.terminals.instances.length, 0);
	});

	test('one rejected close is logged after all original instances release their model', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async id => { if (id === 'pty-1') throw new Error('Transport unavailable'); });
		await scope.create();
		await scope.create();
		await scope.lifecycle.shutdown('quit');
		assert.deepEqual(scope.closes, ['pty-1', 'pty-2']);
		assert.equal(scope.terminals.instances.length, 0);
		assert.equal(scope.errors.length, 1);
	});

	test('contribution disposal withdraws the shutdown participant', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { });
		await scope.create();
		scope.contribution.dispose();
		await scope.lifecycle.shutdown('windowClose');
		assert.deepEqual(scope.closes, []);
		assert.equal(scope.terminals.instances.length, 1);
		await scope.terminals.instances[0]!.close();
	});
});
