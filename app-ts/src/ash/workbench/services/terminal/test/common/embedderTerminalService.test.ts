import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TerminalService } from '../../../../contrib/terminal/browser/terminalService.js';
import { TerminalMainContribution } from '../../../../contrib/terminal/browser/terminalMainContribution.js';
import { ITerminalService, type ITerminalInstance } from '../../../../contrib/terminal/browser/terminal.js';
import { TERMINAL_VIEW_ID } from '../../../../contrib/terminal/common/terminal.js';
import { IViewsService } from '../../../views/common/viewsService.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { IEmbedderTerminalService, type IEmbedderTerminalPty } from '../../common/embedderTerminalService.js';

suite('Embedder terminal creation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('startup requests belong to the window that accepted them', async () => {
		using store = new DisposableStore();
		const first = createServices(store);
		const second = createServices(store);
		const firstHost = store.add(new HostPty());
		const secondHost = store.add(new HostPty());
		first.services.get(IEmbedderTerminalService).createTerminal({ name: 'First window', pty: firstHost });
		store.add(second.services.createInstance(TerminalMainContribution));
		second.services.get(IEmbedderTerminalService).createTerminal({ name: 'Second window', pty: secondHost });
		assert.deepEqual({ first: first.terminals.instances.length, second: second.terminals.instances.map(instance => instance.title), opens: firstHost.opens }, { first: 0, second: ['Second window'], opens: 0 });
		store.add(first.services.createInstance(TerminalMainContribution));
		await Promise.resolve();
		assert.deepEqual([first.terminals.instances.map(instance => instance.title), second.terminals.instances.map(instance => instance.title)], [['First window'], ['Second window']]);
	});

	test('a view subscribing after open receives synchronous output and exit', async () => {
		using store = new DisposableStore();
		const { services, terminals } = createServices(store);
		store.add(services.createInstance(TerminalMainContribution));
		const host = store.add(new HostPty());
		host.onOpen = () => { host.output.fire('first line'); host.ended.fire(0); };
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Early', pty: host });
		const instance = terminals.instances[0];
		const events: (string | number | undefined)[] = [];
		store.add(instance.onDidWriteData(data => events.push(new TextDecoder().decode(data.data))));
		store.add(instance.onDidExit(code => events.push(code)));
		await Promise.resolve();
		assert.deepEqual(events, ['first line', 0]);
	});

	test('queued creation reaches the production contribution with output and exit code zero', async () => {
		using store = new DisposableStore();
		const { services, terminals, reveals } = createServices(store);
		const host = store.add(new HostPty());
		host.onOpen = () => {
			host.output.fire('early output');
			host.ended.fire(0);
		};
		const output: string[] = [];
		const exited: (number | undefined)[] = [];
		store.add(terminals.onDidCreateInstance(instance => {
			store.add(instance.onDidWriteData(data => output.push(new TextDecoder().decode(data.data))));
			store.add(instance.onDidExit(code => exited.push(code)));
		}));
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Host output', pty: host });
		assert.equal(terminals.instances.length, 0);
		store.add(services.createInstance(TerminalMainContribution));
		await Promise.resolve();
		await Promise.resolve();
		const instance = terminals.instances[0];
		assert.deepEqual({ title: instance.title, state: instance.state, exitCode: instance.exitCode, pid: instance.processId, cwd: instance.initialCwd, output, exited, reveals }, {
			title: 'Host output', state: 'exited', exitCode: 0, pid: -1, cwd: '', output: ['early output'], exited: [0], reveals: [TERMINAL_VIEW_ID],
		});
		await instance.close();
		assert.deepEqual({ remaining: terminals.instances.length, opens: host.opens, closes: host.closes }, { remaining: 0, opens: 1, closes: 0 });
	});

	test('running host output is independent of the backend and keeps changed titles', async () => {
		using store = new DisposableStore();
		const { services, terminals } = createServices(store);
		store.add(services.createInstance(TerminalMainContribution));
		const host = store.add(new HostPty());
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Original', pty: host });
		const instance = terminals.instances[0];
		host.name.fire('Renamed');
		const second = store.add(new HostPty());
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Second', pty: second });
		terminals.moveTerminal(instance, 1);
		assert.deepEqual(terminals.instances.map(item => ({ title: item.title, readOnly: item.isReadOnly, state: item.state })), [
			{ title: 'Second', readOnly: true, state: 'running' }, { title: 'Renamed', readOnly: true, state: 'running' },
		]);
		await Promise.all([instance.close(), instance.close()]);
		assert.equal(host.closes, 1);
	});

	test('window disposal closes running and unconsumed host PTYs once', () => {
		using store = new DisposableStore();
		const owner = store.add(new DisposableStore());
		const { services, terminals } = createServices(owner);
		const queued = store.add(new HostPty());
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Queued', pty: queued });
		owner.dispose();
		assert.deepEqual({ opens: queued.opens, closes: queued.closes, instances: terminals.instances.length }, { opens: 0, closes: 1, instances: 0 });

		const runningOwner = store.add(new DisposableStore());
		const running = createServices(runningOwner);
		runningOwner.add(running.services.createInstance(TerminalMainContribution));
		const active = store.add(new HostPty());
		running.services.get(IEmbedderTerminalService).createTerminal({ name: 'Running', pty: active });
		runningOwner.dispose();
		assert.deepEqual({ opens: active.opens, closes: active.closes, instances: running.terminals.instances.length }, { opens: 1, closes: 1, instances: 0 });
	});

	test('closing during instance publication releases the PTY before it opens', async () => {
		using store = new DisposableStore();
		const { services, terminals } = createServices(store);
		const host = store.add(new HostPty());
		store.add(terminals.onDidCreateInstance(instance => instance.dispose()));
		let config!: Parameters<ITerminalService['createTerminal']>[0];
		store.add(services.get(IEmbedderTerminalService).onDidCreateTerminal(value => {
			config = { config: { ...value, customPtyImplementation: value.customPtyImplementation! }, dimensions: { rows: 24, cols: 80 } };
		}));
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Closed', pty: host });
		await assert.rejects(terminals.createTerminal(config), { name: 'CancellationError' });
		assert.deepEqual({ opens: host.opens, closes: host.closes, instances: terminals.instances.length }, { opens: 0, closes: 1, instances: 0 });
	});

	test('relaunch opens a new host process without requesting a backend shell', async () => {
		using store = new DisposableStore();
		const { services, terminals } = createServices(store);
		store.add(services.createInstance(TerminalMainContribution));
		const host = store.add(new HostPty());
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Host', pty: host });
		const instance = terminals.instances[0];
		host.ended.fire(3);
		await terminals.relaunchTerminal(instance, { rows: 30, cols: 100 });
		host.name.fire('Restarted');
		assert.deepEqual({ instances: terminals.instances.length, title: instance.title, state: instance.state, exitCode: instance.exitCode, opens: host.opens }, {
			instances: 1, title: 'Restarted', state: 'running', exitCode: undefined, opens: 2,
		});
		await instance.close();
		assert.equal(host.closes, 1);
	});

	test('open failure retains an error instance whose host resources can be released', async () => {
		using store = new DisposableStore();
		const { services, terminals } = createServices(store);
		store.add(services.createInstance(TerminalMainContribution));
		const host = store.add(new HostPty());
		host.onOpen = () => { throw new Error('Host open failed'); };
		services.get(IEmbedderTerminalService).createTerminal({ name: 'Broken', pty: host });
		await Promise.resolve();
		const instance: ITerminalInstance = terminals.instances[0];
		assert.equal(instance.state, 'error');
		await instance.close();
		assert.deepEqual({ closes: host.closes, instances: terminals.instances.length }, { closes: 1, instances: 0 });
	});
});

class HostPty extends Disposable implements IEmbedderTerminalPty {
	public readonly output = this._register(new Emitter<string>());
	public readonly ended = this._register(new Emitter<void | number>());
	public readonly name = this._register(new Emitter<string>());
	public readonly onDidWrite = this.output.event;
	public readonly onDidClose = this.ended.event;
	public readonly onDidChangeName = this.name.event;
	public opens = 0;
	public closes = 0;
	public onOpen: (() => void) | undefined;
	public open(): void { this.opens++; this.onOpen?.(); }
	public close(): void { this.closes++; }
}

function createServices(owner: DisposableStore): { services: InstantiationService; terminals: ITerminalService; reveals: string[] } {
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IEmbedderTerminalService)?.[1];
	assert.ok(descriptor);
	const workspace = owner.add(new WorkspaceContextService({ id: 'empty-window' }));
	const rejectBackend = async (): Promise<never> => { throw new Error('Host PTY must not access the backend'); };
	const reveals: string[] = [];
	const services = owner.add(new InstantiationService(new ServiceCollection(
		[IEmbedderTerminalService, descriptor],
		[IWorkspaceContextService, workspace],
		[ITerminalProcessService, {
			listProfiles: rejectBackend, create: rejectBackend, write: rejectBackend, resize: rejectBackend, read: rejectBackend, close: rejectBackend,
			getConnectionState: async () => 'crashed', onConnectionState: Event.None,
		}],
		[IViewsService, { openView: async (id: string) => { reveals.push(id); return null; } } as IViewsService],
	)));
	const terminals = owner.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	return { services, terminals, reveals };
}
