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
import { ITerminalService } from '../../../../services/terminal/browser/terminal.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { TerminalService } from '../../browser/terminalService.js';
import { TerminalNativeContribution } from '../../electron-browser/terminalNativeContribution.js';

// Only the host binding is replaced; final joins use the actual lifecycle coordinator.
class WindowLifecycle extends AbstractLifecycleService { }

function fixture(owner: DisposableStore, release: (id: string) => Promise<void>) {
	const browser = new JSDOM('', { url: 'https://terminal.test' });
	owner.add(toDisposable(() => browser.window.close()));
	const services = owner.add(new InstantiationService());
	const storage = owner.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'terminal', flushInterval: 0 }));
	const log = new NullLoggerService();
	const errors: unknown[] = [];
	log.error = (...args) => { errors.push(args); };
	services.registerInstance(ILogService, log);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IWorkspaceContextService, owner.add(new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') })));
	let next = 0;
	const closes: string[] = [];
	services.registerInstance(ITerminalProcessService, {
		operatingSystem: OperatingSystem.Macintosh, onConnectionState: Event.None,
		getConnectionState: async () => 'ready',
		create: async () => ({ terminalId: `pty-${++next}`, ready: { pid: next, cwd: '/workspace' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'reconnectable' }),
		close: async ({ terminalId }: ITerminalProcessCloseOptions) => { closes.push(terminalId); await release(terminalId); },
	} as unknown as ITerminalProcessService);
	const lifecycle = owner.add(new WindowLifecycle(StartupKind.NewWindow, log, storage));
	services.registerInstance(ILifecycleService, lifecycle);
	const terminals = owner.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	const contribution = owner.add(services.createInstance(TerminalNativeContribution));
	const create = () => terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' }, deferStart: true });
	return { terminals, lifecycle, contribution, create, closes, errors };
}

suite('Desktop terminal shutdown confirmation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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
