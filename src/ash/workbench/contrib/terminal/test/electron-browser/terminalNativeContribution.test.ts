import '../../electron-browser/terminal.contribution.js';
import type { ITerminalSerializedState } from '../../../../services/terminal/common/terminal.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { TerminalCommandId } from '../../common/terminal.js';
import { parseTerminalReloadState, TerminalStorageKeys } from '../../common/terminalStorageKeys.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi, ITerminalWindowTransfer, ITerminalWindowTransferResult } from '../../../../../platform/native/common/nativeHost.js';
import type { ITerminalReconnectLease } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalTransferError, type ITerminalInstance } from '../../browser/terminal.js';
import { TerminalAccessibilityHelpProvider } from '../../../terminalContrib/accessibility/browser/terminalAccessibilityHelp.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { registerTestTerminalCreationServices } from '../../../../test/browser/workbenchTestServices.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem, isMacintosh } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITerminalProcessService, TERMINAL_REVIVE_STATE_KEY, type ITerminalProcessCloseOptions } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AbstractLifecycleService } from '../../../../services/lifecycle/common/lifecycleService.js';
import { ILifecycleService, StartupKind, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ITerminalService, ITerminalGroupService } from '../../browser/terminal.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TerminalGroupService } from '../../browser/terminalGroupService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { ShutdownVetoError } from '../../../../services/lifecycle/common/lifecycle.js';
import '../../common/terminalConfiguration.js';
import { BaseSecretStorageService, ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
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
	services.registerInstance(IConfigurationService, owner.add(new TestConfigurationService({ source: JSON.stringify({ 'terminal.integrated.persistentSessionReviveProcess': 'never', ...settings }) })));
	services.registerInstance(INativeHostService, { listWindows: async () => [], takeTerminalTransfer: async () => undefined, onDidRequestTerminalTransfer: () => ({ dispose() { } }) } as unknown as INativeHostApi);
	services.registerInstance(IWorkspaceContextService, owner.add(new TestWorkspaceService({ id: 'workspace', uri: URI.file('/workspace') })));
	let next = 0;
	const closes: string[] = [];
	const writes: string[] = [];
	services.registerInstance(ITerminalProcessService, {
		operatingSystem: OperatingSystem.Macintosh, onConnectionState: Event.None,
		getConnectionState: async () => 'ready',
		read: async ({ terminalId, afterSequence, afterCommandSequence }: { terminalId: string; afterSequence: number; afterCommandSequence: number; }) => ({ terminalId, chunks: [], nextSequence: afterSequence, outputGap: false, commandEvents: [], nextCommandSequence: afterCommandSequence, commandEventGap: false, exited: false }),
		create: async () => ({ terminalId: `pty-${++next}`, ready: { pid: next, cwd: '/workspace' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'reconnectable' }),
		close: async ({ terminalId }: ITerminalProcessCloseOptions) => { closes.push(terminalId); await release(terminalId); },
		getProcessInfo: async () => ({ ready: { pid: 1, cwd: '/workspace' }, cwd: '/workspace', cols: 80, rows: 24, hasChildProcesses: true }),
		write: async ({ data }: { data: string; }) => { writes.push(data); },
	} as unknown as ITerminalProcessService);
	const lifecycle = owner.add(new WindowLifecycle(StartupKind.NewWindow, log, storage));
	services.registerInstance(ILifecycleService, lifecycle);
	services.registerSingleton(ITerminalGroupService, () => services.createInstance(TerminalGroupService), { instantiation: InstantiationType.Delayed });
	registerTestTerminalCreationServices(services);
	const terminals = owner.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	services.registerInstance(IViewsService, { openView: async () => null } as unknown as IViewsService);
	const contribution = owner.add(services.createInstance(TerminalNativeContribution));
	const create = () => terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' }, revivalLaunch: { profile: { type: 'default' } }, deferStart: true });
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

suite('Desktop terminal exit revival', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const [reason, policy, enabled, expected] of [
		['quit', 'onExit', true, true],
		['windowClose', 'onExitAndWindowClose', true, true],
		['windowClose', 'onExit', true, !isMacintosh],
		['quit', 'never', true, false],
		['windowClose', 'never', true, false],
		['quit', 'onExitAndWindowClose', false, false],
	] as const) test(`${reason} with ${policy} and enabled=${enabled} commits revival=${expected} before process release`, async () => {
		using owner = new DisposableStore();
		const effects: string[] = [];
		const scope = fixture(owner, async () => {
			if (expected) assert.ok(effects.includes('flush'));
			effects.push('close');
		}, { 'terminal.integrated.persistentSessionReviveProcess': policy, 'terminal.integrated.enablePersistentSessions': enabled });
		scope.services.get(INativeHostService).listWindows = async () => [{ id: 1, title: 'Only window', current: true, focused: true }];
		const instance = await scope.create();
		instance.serializeState = async options => { assert.deepEqual(options, { revive: true }); effects.push('serialize'); return exitSnapshot(instance); };
		const storage = scope.services.get(IStorageService);
		await storage.flush();
		const flush = storage.flush.bind(storage);
		storage.flush = async (...args) => { await flush(...args); effects.push('flush'); };
		await scope.lifecycle.shutdown(reason);
		const state = storage.get(TerminalStorageKeys.Revive, StorageScope.WORKSPACE);
		assert.equal(state !== undefined, expected);
		if (state) assert.equal(parseTerminalReloadState(state).kind, 'revive');
		assert.equal(effects.includes('serialize'), expected);
		assert.deepEqual(scope.closes, ['pty-1']);
		assert.equal(scope.terminals.instances.length, 0);
	});

	test('exit checkpoint excludes tasks, read-only terminals and already exited processes', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { }, { 'terminal.integrated.persistentSessionReviveProcess': 'onExit' });
		const interactive = await scope.create();
		interactive.serializeState = async () => exitSnapshot(interactive);
		const task = await scope.create();
		task.serializeState = async () => ({ ...exitSnapshot(task), launch: undefined });
		for (const [field, value] of [['state', 'exited'], ['isReadOnly', true]] as const) {
			const excluded = await scope.create();
			Object.defineProperty(excluded, field, { value });
			excluded.serializeState = async () => { throw new Error('Excluded processes must not be checkpointed'); };
		}
		await scope.lifecycle.shutdown('quit');
		const state = parseTerminalReloadState(scope.services.get(IStorageService).get(TerminalStorageKeys.Revive, StorageScope.WORKSPACE)!);
		assert.deepEqual(state.instances.map(instance => instance.instanceId), [interactive.instanceId]);
		assert.deepEqual(state.groups.map(group => group.ids), [[interactive.instanceId]]);
		assert.equal(scope.closes.length, 4);
	});

	test('reload omits failed and retired terminals while preserving healthy processes and their layout', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { });
		const failed = await scope.create();
		Object.defineProperty(failed, 'state', { value: 'error' });
		failed.serializeState = async () => { throw new Error('A failed process cannot be serialized'); };
		const retired = await scope.create();
		retired.serializeState = async () => exitSnapshot(retired);
		const healthy = await scope.create();
		healthy.serializeState = async () => exitSnapshot(healthy);
		const requested: string[] = [];
		const processes = scope.services.get(ITerminalProcessService);
		processes.getReconnectLease = async terminalId => {
			requested.push(terminalId);
			return terminalId === retired.id ? undefined : { terminalId, reconnectToken: 'a'.repeat(64), reconnectGracePeriodMillis: 30000 };
		};
		let committed = false;
		processes.prepareForReload = () => { committed = true; };
		await scope.lifecycle.shutdown('reload');
		const storage = scope.services.get(IStorageService);
		const credentials = JSON.parse((await scope.services.get(ISecretStorageService).get(TerminalStorageKeys.Reload))!);
		const checkpoint = parseTerminalReloadState(storage.get(credentials.stateKey, StorageScope.WORKSPACE)!);
		assert.deepEqual(requested, [retired.id, healthy.id]);
		assert.deepEqual(checkpoint.instances.map(instance => instance.instanceId), [healthy.instanceId]);
		assert.deepEqual(checkpoint.groups.map(group => group.ids), [[healthy.instanceId]]);
		assert.deepEqual(credentials.leases.map((lease: { terminalId: string; }) => lease.terminalId), [healthy.id]);
		assert.deepEqual({ committed, errors: scope.errors, closes: scope.closes }, { committed: true, errors: [], closes: [] });
	});

	test('reload still fails if a live terminal cannot obtain its credential because of a transport error', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { });
		const instance = await scope.create();
		instance.serializeState = async () => exitSnapshot(instance);
		const failure = new Error('Live terminal attach transport failed');
		scope.services.get(ITerminalProcessService).getReconnectLease = async () => { throw failure; };
		await assert.rejects(scope.lifecycle.shutdown('reload'), error => error instanceof AggregateError && error.errors[0]?.cause === failure);
		assert.deepEqual(scope.closes, []);
		assert.equal(await scope.services.get(ISecretStorageService).get(TerminalStorageKeys.Reload), undefined);
	});

	for (const foreignScope of ['workspace', 'remote host'] as const) test(`foreign ${foreignScope} checkpoint cannot mutate current terminal groups or input selection`, async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { });
		// Withdraw startup restoration before its first await completes; this
		// scenario installs a checkpoint after the current terminals exist.
		scope.contribution.dispose();
		const first = await scope.create();
		const second = await scope.create();
		const groups = scope.services.get(ITerminalGroupService);
		const originalGroups = groups.groups.map(group => [...group.terminalInstances]);
		const joined: number[][] = [];
		const join = groups.joinInstances.bind(groups);
		groups.joinInstances = instances => { joined.push(instances.map(instance => instance.instanceId)); join(instances); };
		let starts = 0;
		first.start = second.start = () => { starts++; };
		const key = 'terminal.revive.11111111-1111-1111-1111-111111111111';
		const unrelatedKey = 'terminal.revive.22222222-2222-2222-2222-222222222222';
		await scope.services.get(ISecretStorageService).set(TERMINAL_REVIVE_STATE_KEY, key);
		const storage = scope.services.get(IStorageService);
		storage.store(key, JSON.stringify({
			version: 1, kind: 'revive', workspaceId: foreignScope === 'workspace' ? 'another-workspace' : 'workspace',
			...(foreignScope === 'remote host' ? { remoteAuthority: 'ssh+another-host' } : {}),
			instances: [exitSnapshot(first), exitSnapshot(second)], activeId: first.instanceId,
			groups: [{ ids: [first.instanceId, second.instanceId], sizes: [0.4, 0.6] }],
		}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storage.store(unrelatedKey, 'another window owns this checkpoint', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const cleared = new DeferredPromise<void>();
		const flush = storage.flush.bind(storage);
		storage.flush = async (...args) => {
			await flush(...args);
			if (storage.get(key, StorageScope.WORKSPACE) === undefined && !cleared.isSettled) cleared.complete();
		};
		scope.lifecycle.phase = LifecyclePhase.Restored;
		owner.add(scope.services.createInstance(TerminalNativeContribution));
		await cleared.p;
		assert.deepEqual(joined, []);
		assert.deepEqual(groups.groups.map(group => [...group.terminalInstances]), originalGroups);
		assert.equal(scope.terminals.activeInstance, second);
		assert.equal(starts, 0);
		assert.equal(storage.get(key, StorageScope.WORKSPACE), undefined);
		assert.equal(storage.get(unrelatedKey, StorageScope.WORKSPACE), 'another window owns this checkpoint');
	});

	test('partial restoration keeps the checkpoint and leases after restoring the surviving layout', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { });
		scope.contribution.dispose();
		const first = await scope.create();
		const second = await scope.create();
		const snapshots = [exitSnapshot(first), exitSnapshot(second)];
		await scope.terminals.closeTerminal(first);
		const stateKey = 'terminal.reload.12345678-1234-1234-1234-123456789abc';
		const text = JSON.stringify({ version: 1, workspaceId: 'workspace', instances: snapshots, groups: [{ ids: snapshots.map(snapshot => snapshot.instanceId), sizes: [0.5, 0.5] }] });
		const storage = scope.services.get(IStorageService);
		storage.store(stateKey, text, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const secrets = scope.services.get(ISecretStorageService);
		const credentials = JSON.stringify({ stateKey, expiresAt: Date.now() + 60_000, leases: snapshots.map(snapshot => ({ terminalId: snapshot.process.terminalId, reconnectToken: 'a'.repeat(64), reconnectGracePeriodMillis: 0 })) });
		await secrets.set(TerminalStorageKeys.Reload, credentials);
		const started = new DeferredPromise<void>();
		second.start = () => { started.complete(); };
		scope.lifecycle.phase = LifecyclePhase.Restored;
		owner.add(scope.services.createInstance(TerminalNativeContribution));
		await started.p;
		assert.equal(storage.get(stateKey, StorageScope.WORKSPACE), text);
		assert.equal(await secrets.get(TerminalStorageKeys.Reload), credentials);
	});

	test('failed exit serialization removes stale revival state and still closes the window terminals', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { }, { 'terminal.integrated.persistentSessionReviveProcess': 'onExit' });
		const instance = await scope.create();
		const storage = scope.services.get(IStorageService);
		await storage.flush();
		storage.store(TerminalStorageKeys.Revive, JSON.stringify({ version: 1, kind: 'revive', workspaceId: 'workspace', instances: [], groups: [] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		// No DOM screen exists in this lifecycle fixture: the real serializer pauses
		// the process manager before reporting that screen recovery is unavailable.
		await scope.lifecycle.shutdown('quit');
		assert.deepEqual(scope.closes, ['pty-1']);
		assert.equal(scope.errors.length, 1);
		assert.equal(storage.get(TerminalStorageKeys.Revive, StorageScope.WORKSPACE), undefined);
		assert.equal(scope.terminals.instances.length, 0);
		assert.equal(scope.lifecycle.willShutdown, true);
	});

	test('failed reload serialization keeps the original process client usable', async () => {
		using owner = new DisposableStore();
		const scope = fixture(owner, async () => { });
		const instance = await scope.create();
		await assert.rejects(scope.lifecycle.shutdown('reload'), /shutdown participants failed/);
		assert.deepEqual(scope.closes, []);
		await instance.sendText('after-failed-reload', false);
		assert.deepEqual(scope.writes, ['after-failed-reload']);
		assert.equal(scope.terminals.activeInstance, instance);
	});
});

function exitSnapshot(instance: ITerminalInstance): ITerminalSerializedState {
	return {
		instanceId: instance.instanceId, resource: instance.resource!.toString(), dirId: instance.dirId,
		process: { terminalId: instance.id, ready: { pid: instance.processId, cwd: '/workspace' }, profile: instance.profile, connectionPersistence: 'reconnectable' },
		title: instance.title, target: 1, cols: 80, rows: 24, sequence: 0, pendingUtf8: [], vt: '', cwd: '/workspace', launch: { profile: { type: 'default' } },
	};
}

suite('Desktop terminal move command transaction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const target of [undefined, 42]) test(`moves the captured PID to ${target === undefined ? 'a new window' : 'an existing window'} only after attachment acknowledgement`, async () => {
		using owner = new DisposableStore();
		const f = transferCommandFixture(owner);
		const moving = f.commands.executeCommand(TerminalCommandId.MoveIntoNewWindow, target);
		const transfer = await f.requested.p;
		assert.equal(f.closed(), false);
		await assert.rejects(f.instance.sendText('pending', false), /paused/);
		assert.equal(transfer.targetWindowId, target);
		const state = parseTerminalReloadState(transfer.transfer.state);
		assert.equal(state.instances[0]!.process.ready.pid, 321);
		assert.equal(state.workspaceId, 'workspace');
		f.selectOther();
		await f.reply.complete({ id: transfer.transfer.id });
		await moving;
		assert.equal(f.closed(), true);
		assert.deepEqual(f.killed, []);
		assert.deepEqual(f.effects, ['serialize', 'detach', 'move', 'close']);
		assert.equal(f.terminals.activeInstance, f.other);
	});

	for (const failure of ['detach', 'open', 'receiver', 'rollback'] as const) test(`restores the original input client after ${failure} failure`, async () => {
		using owner = new DisposableStore();
		const f = transferCommandFixture(owner, failure);
		const moving = f.commands.executeCommand(TerminalCommandId.MoveIntoNewWindow);
		const rejected = assert.rejects(moving, failure === 'detach' ? /detach denied/ : /target rejected/);
		if (failure !== 'detach') {
			const request = await f.requested.p;
			if (failure === 'open') await f.reply.error(new Error('target rejected'));
			else await f.reply.complete({ id: request.transfer.id, error: 'target rejected', lease: { ...f.lease, reconnectToken: 'b'.repeat(64) } });
		}
		await rejected;
		if (failure === 'rollback') {
			assert.equal(f.closed(), true);
			assert.equal(f.errors.length, 1);
			assert.deepEqual(f.killed, []);
		} else {
			assert.equal(f.closed(), false);
			await f.instance.sendText('after rollback', false);
			assert.deepEqual(f.writes, ['after rollback']);
			assert.deepEqual(f.killed, []);
			if (failure !== 'detach') assert.equal(f.attached[0]!.reconnectToken, (failure === 'receiver' ? 'b' : 'a').repeat(64));
		}
	});

	test('validates payload and target before detaching a paused source', async () => {
		using owner = new DisposableStore();
		const f = transferCommandFixture(owner);
		await assert.rejects(f.commands.executeCommand(TerminalCommandId.MoveIntoNewWindow, -1), /Invalid terminal transfer target/);
		assert.deepEqual(f.effects, []);
		f.snapshot.vt = 'x'.repeat(16 * 1024 * 1024 + 1);
		await assert.rejects(f.commands.executeCommand(TerminalCommandId.MoveIntoNewWindow), /Invalid terminal screen checkpoint/);
		assert.deepEqual(f.effects, ['serialize', 'start']);
		await f.instance.sendText('after validation', false);
		assert.deepEqual(f.writes, ['after validation']);
	});

	test('the move action and accessibility help use the non-default language', async () => {
		using owner = new DisposableStore();
		const f = transferCommandFixture(owner);
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		using help = new TerminalAccessibilityHelpProvider(f.instance, true);
		assert.match(help.provideContent(), /将终端移入新窗口/);
		f.instance.shellLaunchConfig = { customPtyImplementation: () => { throw new Error('unused'); } };
		await assert.rejects(f.commands.executeCommand(TerminalCommandId.MoveIntoNewWindow), /此终端无法将其进程移至其他窗口/);
	});
});

function transferCommandFixture(owner: DisposableStore, failure?: 'detach' | 'open' | 'receiver' | 'rollback') {
	const services = owner.add(new InstantiationService());
	const workspace = owner.add(new TestWorkspaceService({ id: 'workspace', uri: URI.file('/workspace') }));
	services.registerInstance(IWorkspaceContextService, workspace);
	const log = new NullLoggerService();
	const errors: unknown[] = [];
	log.error = (...args) => { errors.push(args); };
	services.registerInstance(ILogService, log);
	const effects: string[] = [];
	const writes: string[] = [];
	const killed: number[] = [];
	const attached: ITerminalReconnectLease[] = [];
	const lease: ITerminalReconnectLease = { terminalId: 'transfer-process', dirId: 'workspace', reconnectToken: 'a'.repeat(64), reconnectGracePeriodMillis: 30_000 };
	const snapshot = {
		instanceId: 1, resource: 'vscode-terminal:/source/1', dirId: 'workspace', processDirId: 'workspace',
		process: { terminalId: lease.terminalId, ready: { pid: 321, cwd: '/workspace' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'reconnectable' as const },
		title: 'Shell', target: 1, cols: 80, rows: 24, sequence: 4, pendingUtf8: [], vt: 'retained output',
	};
	let paused = false;
	let closed = false;
	let ownsProcess = true;
	let active: ITerminalInstance;
	const instances: ITerminalInstance[] = [];
	const instance = {
		instanceId: 1, state: 'running', title: 'Shell', shellLaunchConfig: undefined as import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig | undefined,
		serializeState: async () => { paused = true; effects.push('serialize'); return snapshot; },
		start: () => { paused = false; effects.push('start'); },
		sendText: async (text: string) => { if (paused) throw new Error('input is paused'); writes.push(text); },
		close: async () => { closed = true; effects.push('close'); if (ownsProcess) killed.push(321); instances.splice(instances.indexOf(instance as unknown as ITerminalInstance), 1); },
	} as unknown as ITerminalInstance & { shellLaunchConfig: import('../../../../../platform/terminal/common/terminal.js').IShellLaunchConfig | undefined; };
	const other = { instanceId: 2 } as ITerminalInstance;
	instances.push(instance);
	active = instance;
	const terminals = { instances, get activeInstance() { return active; } } as unknown as ITerminalService;
	services.registerInstance(ITerminalService, terminals);
	services.registerInstance(ITerminalProcessService, {
		getReconnectLease: async () => ({ ...lease, reconnectGracePeriodMillis: 0 }),
		detach: async () => { effects.push('detach'); if (failure === 'detach') throw new Error('detach denied'); ownsProcess = false; return lease; },
		attach: async (credential: ITerminalReconnectLease) => { effects.push('attach'); attached.push(credential); if (failure === 'rollback') throw new Error('rollback denied'); ownsProcess = true; return snapshot.process; },
		close: async () => { killed.push(321); },
	} as unknown as ITerminalProcessService);
	const requested = new DeferredPromise<{ transfer: ITerminalWindowTransfer; targetWindowId?: number; }>();
	const reply = new DeferredPromise<ITerminalWindowTransferResult>();
	services.registerInstance(INativeHostService, {
		moveTerminalToWindow: async (transfer: ITerminalWindowTransfer, targetWindowId?: number) => { effects.push('move'); await requested.complete({ transfer, targetWindowId }); return reply.p; },
	} as INativeHostApi);
	const commands = owner.add(new CommandService(services));
	return { commands, requested, reply, terminals, instance, other, snapshot, lease, effects, writes, killed, attached, errors, closed: () => closed, selectOther: () => { instances.push(other); active = other; } };
}


suite('Desktop terminal transfer receiver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const failure of ['construction', 'focus', undefined] as const) test(`receiver ${failure ?? 'success'} completes with the correct ownership and focus`, async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, async () => { });
		await f.terminals.whenConnected;
		f.contribution.dispose();
		const lease: ITerminalReconnectLease = { terminalId: 'transferred-process', dirId: 'workspace', reconnectToken: 'a'.repeat(64), reconnectGracePeriodMillis: 30_000 };
		const rotated = { ...lease, reconnectToken: 'b'.repeat(64) };
		const events: string[] = [];
		const complete = new DeferredPromise<ITerminalWindowTransferResult>();
		const imported = new DeferredPromise<void>();
		const snapshot = {
			instanceId: 1, resource: 'vscode-terminal:/source/1', dirId: 'workspace', processDirId: 'workspace',
			process: { terminalId: lease.terminalId, ready: { pid: 321, cwd: '/workspace' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'reconnectable' },
			title: 'Shell', target: 1, cols: 80, rows: 24, sequence: 0, pendingUtf8: [], vt: 'screen',
		};
		let taken = false;
		Object.assign(f.services.get(INativeHostService), {
			onDidRequestTerminalTransfer: () => ({ dispose() { } }),
			takeTerminalTransfer: async () => {
				if (taken) return undefined;
				taken = true;
				return { id: 'transfer-1', lease, state: JSON.stringify({ version: 1, workspaceId: 'workspace', instances: [snapshot], groups: [] }) };
			},
			completeTerminalTransfer: async (result: ITerminalWindowTransferResult) => { await complete.complete(result); },
			focusWindow: async () => { events.push('focusWindow'); if (failure === 'focus') throw new Error('x'.repeat(3_000)); },
		} satisfies Partial<INativeHostApi>);
		f.services.get(ITerminalGroupService).showPanel = async () => { events.push('showPanel'); };
		f.services.get(ITerminalProcessService).detach = async () => { events.push('detach'); return rotated; };
		f.terminals.importTerminalState = async () => {
			await imported.complete();
			if (failure === 'construction') throw new TerminalTransferError(rotated);
			return { start: () => events.push('start'), close: async () => { events.push('close'); }, xterm: { focus: () => events.push('focusScreen') } } as unknown as ITerminalInstance;
		};
		owner.add(f.services.createInstance(TerminalNativeContribution));
		await imported.p;
		assert.deepEqual(events, [], 'Transfer must not race the workbench startup focus restore');
		f.lifecycle.phase = LifecyclePhase.Restored;
		const result = await complete.p;
		if (failure) {
			assert.equal(result.id, 'transfer-1');
			assert.deepEqual(result.lease, rotated);
			assert.ok(result.error && result.error.length <= 2_048);
			assert.equal(result.error.includes(rotated.reconnectToken), false);
			assert.deepEqual(events, failure === 'construction' ? [] : ['showPanel', 'focusWindow', 'detach', 'close']);
		} else {
			assert.deepEqual(result, { id: 'transfer-1' });
			assert.deepEqual(events, ['showPanel', 'focusWindow', 'start', 'focusScreen']);
		}
	});
});
