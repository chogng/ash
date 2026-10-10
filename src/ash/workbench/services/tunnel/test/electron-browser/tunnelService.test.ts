import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { test } from 'mocha';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IPCClient } from '../../../../../base/parts/ipc/common/ipc.js';
import { remotePortForwardingChannel } from '../../../../../platform/remote/electron-main/remotePortForwardingIpc.js';
import { SshPortForwardingService } from '../../../../../platform/remote/electron-main/sshPortForwardingService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import type { SshPortForward as Forward, SshPortForwardChange as ForwardChange } from '../../../../../platform/remote/electron-main/sshPortForwardingService.js';
import { TunnelPrivacyId, type RemoteTunnel } from '../../../../../platform/tunnel/common/tunnel.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { TunnelService } from '../../electron-browser/tunnelService.js';
import chinese from '../../../../../../../localization/zh-CN/workbench.json' with { type: 'json' };
import { ITunnelService } from '../../../../../platform/tunnel/common/tunnel.js';


test('Tunnel handles share a forward and release the process after the last reference', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	const first = await open(service);
	const second = await open(service);
	assert.deepEqual({ host: first.tunnelRemoteHost, port: first.tunnelRemotePort, localAddress: first.localAddress, privacy: first.privacy }, {
		host: '127.0.0.1', port: 3000, localAddress: '127.0.0.1:13000', privacy: TunnelPrivacyId.ConstantPrivate,
	});
	await first.dispose();
	assert.deepEqual(api.closed, []);
	await second.dispose();
	await second.dispose();
	assert.deepEqual(api.closed, ['one']);
});

test('Tunnel events keep recovery state and a stale list cannot resurrect a removed forward', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	await open(service);
	const events: unknown[] = [];
	using opened = service.onTunnelOpened(tunnel => events.push(tunnel.state));
	using closed = service.onTunnelClosed(address => events.push(address));
	let reply!: (value: readonly Forward[]) => void;
	api.nextList = new Promise(resolve => { reply = resolve; });
	const pending = service.tunnels;
	api.upsert({ ...api.forward!, state: 'recovering' });
	await api.close('one');
	reply([{ id: 'one', remoteHost: '127.0.0.1', remotePort: 3000, localPort: 13000, state: 'open' }]);
	assert.deepEqual(await pending, []);
	assert.deepEqual(events, ['recovering', { host: '127.0.0.1', port: 3000 }]);
});

test('A retired Tunnel handle cannot close a replacement on the same remote port', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	const first = await open(service);
	await service.closeTunnel('localhost', 3000);
	api.nextId = 'two';
	await open(service);
	await first.dispose();
	assert.deepEqual(api.closed, ['one']);
	assert.equal((await service.tunnels)[0]?.tunnelRemotePort, 3000);
});

test('Unsupported Tunnel options are rejected before IPC and use Chinese localization', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	setNlsMessages('zh-CN', chinese);
	try {
		assert.equal(await service.openTunnel(undefined, '0.0.0.0', 3000), chinese.ash['tunnel.unsupportedOptions']);
		assert.equal(await service.openTunnel(undefined, 'localhost', 3000, undefined, 3000), chinese.ash['tunnel.unsupportedOptions']);
		await assert.rejects(service.openTunnel(undefined, 'localhost', 0), { message: chinese.ash['tunnel.invalidPort'] });
		assert.equal(api.opens, 0);
	} finally {
		resetNlsResolver();
	}
});

test('A failed Tunnel release can be retried without losing its reference', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	const tunnel = await open(service);
	api.closeError = new Error('IPC close failed');
	await assert.rejects(tunnel.dispose(), { message: 'IPC close failed' });
	api.closeError = undefined;
	await tunnel.dispose();
	assert.deepEqual(api.closed, ['one', 'one']);
	assert.deepEqual(await service.tunnels, []);
});

test('A late close notification preserves a replacement with the same Tunnel address', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	await open(service);
	const closed: unknown[] = [];
	using listener = service.onTunnelClosed(address => closed.push(address));
	api.upsert({ ...api.forward!, id: 'two', localPort: 14000 });
	api.emitRemoval('one');
	assert.deepEqual(closed, []);
	assert.equal((await service.tunnels)[0]?.localAddress, '127.0.0.1:14000');
});

test('Desktop TunnelService requires the Main process service when constructed', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(TunnelService), /mainProcessService/);
});

test('Concurrent Tunnel opens share one startup and keep independent leases', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	let finish!: () => void;
	api.pendingOpen = new Promise(resolve => { finish = resolve; });
	const first = open(service);
	const second = open(service);
	assert.equal(api.opens, 1);
	finish();
	const handles = await Promise.all([first, second]);
	await handles[0].dispose();
	assert.deepEqual(api.closed, []);
	await handles[1].dispose();
	assert.deepEqual(api.closed, ['one']);
});

test('Desktop service disposal releases a late open result without publishing a lease', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	let finish!: () => void;
	api.pendingOpen = new Promise(resolve => { finish = resolve; });
	const opening = service.openTunnel(undefined, 'localhost', 3000);
	service.dispose();
	finish();
	assert.equal(await opening, undefined);
	assert.deepEqual(api.closed, ['one']);
});

test('Desktop TunnelService rejects malformed Main tunnel data before exposing handles', async () => {
	using api = new TestChannelOwner();
	using services = new InstantiationService();
	registerMainProcess(services, api);
	using service = services.createInstance(TunnelService);
	api.nextList = Promise.resolve([{ id: 'unsafe', remoteHost: '0.0.0.0', remotePort: 3000, localPort: 13000, state: 'open' }] as unknown as Forward[]);
	await assert.rejects(service.tunnels, /Invalid Remote tunnel reply/);
	assert.deepEqual(await service.tunnels, []);
});

test('Desktop tunnels cross the Main channel into the window SSH owner and close its process', async () => {
	using resources = new DisposableStore();
	const children: TestSshChild[] = [];
	const hosts: string[] = [];
	const owner = (host: string): SshPortForwardingService => resources.add(new SshPortForwardingService({
		getWorkspace: () => ({ id: host, remoteAuthority: `ssh+${host}` }),
		sshExecutable: 'ssh',
		localEnvironment: { SSH_AUTH_SOCK: '/private/agent.sock' },
		reserveLocalPort: async () => 13000,
		spawnProcess: (_executable, args) => {
			hosts.push(args.at(-1)!);
			const child = new TestSshChild();
			children.push(child);
			return child as unknown as ChildProcess;
		},
		probeLoopbackListener: async () => 'ready',
	}));
	const firstOwner = owner('first-host');
	const secondOwner = owner('second-host');
	const otherForward = await secondOwner.open({ remotePort: 3000 });
	const rendererMessages = resources.add(new Emitter<VSBuffer>());
	const mainMessages = resources.add(new Emitter<VSBuffer>());
	const renderer = resources.add(new IPCClient({
		onMessage: rendererMessages.event,
		send: buffer => queueMicrotask(() => mainMessages.fire(buffer)),
	}, 'renderer'));
	const main = resources.add(new IPCClient({
		onMessage: mainMessages.event,
		send: buffer => queueMicrotask(() => rendererMessages.fire(buffer)),
	}, 'window:1'));
	main.registerChannel('remotePortForwarding', remotePortForwardingChannel(context => {
		assert.equal(context, 'window:1');
		return firstOwner;
	}));
	using services = new InstantiationService();
	services.registerInstance(IMainProcessService, {
		_serviceBrand: undefined,
		getChannel: name => renderer.getChannel(name),
		registerChannel: () => { throw new Error('Unexpected registration'); },
	});
	using service = services.createInstance(TunnelService);
	const opened: string[] = [];
	using listener = service.onTunnelOpened(tunnel => opened.push(tunnel.localAddress));
	const tunnel = await open(service);
	assert.deepEqual({ hosts, opened, localAddress: tunnel.localAddress }, {
		hosts: ['second-host', 'first-host'], opened: ['127.0.0.1:13000'], localAddress: '127.0.0.1:13000',
	});
	const channel = renderer.getChannel('remotePortForwarding');
	await assert.rejects(channel.call('ash:remote:tunnel:open', { remotePort: 3000, window: 'window:2' }), /exactly required keys/);
	await assert.rejects(channel.call('ash:remote:tunnel:open', { remotePort: 0 }), /positive/);
	await assert.rejects(channel.call('ash:remote:tunnel:list', { host: 'second-host' }), /does not accept parameters/);
	await tunnel.dispose();
	assert.deepEqual(await service.tunnels, []);
	assert.deepEqual({ firstExit: children[1]?.exitCode, otherExit: children[0]?.exitCode, otherTunnels: await secondOwner.list() }, {
		firstExit: 0, otherExit: null, otherTunnels: [otherForward],
	});
});

class TestSshChild extends EventEmitter {
	public exitCode: number | null = null;
	public kill(): boolean {
		if (this.exitCode === null) {
			this.exitCode = 0;
			this.emit('exit', 0, null);
			this.emit('close', 0, null);
		}
		return true;
	}
}

async function open(service: TunnelService): Promise<RemoteTunnel> {
	const tunnel = await service.openTunnel(undefined, '127.0.0.1', 3000);
	assert.ok(tunnel && typeof tunnel !== 'string');
	return tunnel;
}

class TestChannelOwner extends Disposable {
	private readonly changed = this._register(new Emitter<ForwardChange>());
	public readonly onDidChange = this.changed.event;
	public readonly closed: string[] = [];
	public forward: Forward | undefined;
	public nextList: Promise<readonly Forward[]> | undefined;
	public nextId = 'one';
	public opens = 0;
	public closeError: Error | undefined;
	public pendingOpen: Promise<void> | undefined;

	public list(): Promise<readonly Forward[]> {
		const pending = this.nextList;
		this.nextList = undefined;
		return pending ?? Promise.resolve(this.forward ? [this.forward] : []);
	}

	public async open(request: { remotePort: number; }): Promise<Forward> {
		this.opens++;
		await this.pendingOpen;
		const forward = this.forward ?? { id: this.nextId, remoteHost: '127.0.0.1', remotePort: request.remotePort, localPort: 13000, state: 'open' } as const;
		this.upsert(forward);
		return forward;
	}

	public async close(id: string): Promise<void> {
		this.closed.push(id);
		if (this.closeError) {
			throw this.closeError;
		}
		if (this.forward?.id === id) {
			this.forward = undefined;
			this.changed.fire({ kind: 'removed', id });
		}
	}

	public async closeAll(): Promise<void> {
		if (this.forward) {
			await this.close(this.forward.id);
		}
	}

	public upsert(forward: Forward): void {
		this.forward = forward;
		this.changed.fire({ kind: 'upsert', tunnel: forward });
	}

	public emitRemoval(id: string): void {
		this.changed.fire({ kind: 'removed', id });
	}
}

function registerMainProcess(services: InstantiationService, owner: TestChannelOwner): void {
	services.registerInstance(IMainProcessService, {
		_serviceBrand: undefined,
		getChannel: name => {
			assert.equal(name, 'remotePortForwarding');
			return {
				call: async <T>(command: string, value?: unknown): Promise<T> => {
					switch (command) {
						case 'ash:remote:tunnel:list': return await owner.list() as T;
						case 'ash:remote:tunnel:open': return await owner.open(value as { remotePort: number; }) as T;
						case 'ash:remote:tunnel:close': await owner.close((value as { id: string; }).id); return undefined as T;
						default: throw new Error('Unexpected tunnel call');
					}
				},
				listen: <T>(event: string) => {
					assert.equal(event, 'ash:remote:tunnel:changed');
					return owner.onDidChange as Event<T>;
				},
			};
		},
		registerChannel: () => { throw new Error('Unexpected channel registration'); },
	});
}

function fixture() {
	const children: Child[] = [];
	const host = new SshPortForwardingService({
		getWorkspace: () => ({ id: 'remote', remoteAuthority: 'ssh+fixture' }),
		sshExecutable: 'ssh',
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => {
			const child = new Child();
			children.push(child);
			return child as unknown as ChildProcess;
		},
		probeLoopbackListener: async () => 'ready',
		wait: async () => { },
	});
	const channel = remotePortForwardingChannel(() => host);
	const call = <T>(method: string, params?: unknown): Promise<T> => channel.call<T>('window:1', `ash:remote:tunnel:${method}`, params);
	const services = new InstantiationService();
	services.registerInstance(IMainProcessService, {
		_serviceBrand: undefined,
		getChannel: () => ({ call: <T>(command: string, value?: unknown) => channel.call<T>('window:1', command, value), listen: <T>(event: string) => channel.listen<T>('window:1', event) }),
		registerChannel: () => { throw new Error('Unexpected channel registration'); },
	});
	const tunnel = services.createInstance(TunnelService);
	services.registerInstance(ITunnelService, tunnel);
	return { host, services, tunnel: services.get(ITunnelService), children, call };
}

test('Workbench tunnel handles share the host forward across loopback aliases and release idempotently', async () => {
	const f = fixture();
	using host = f.host;
	using services = f.services;
	const [first, second] = await Promise.all([
		f.tunnel.openTunnel(undefined, 'localhost', 3000),
		f.tunnel.openTunnel(undefined, '::1', 3000),
	]);
	assert.ok(first && typeof first !== 'string');
	assert.ok(second && typeof second !== 'string');
	assert.equal(f.children.length, 1);
	assert.equal(first.localAddress, second.localAddress);
	const existing = await f.tunnel.getExistingTunnel('127.0.0.1', 3000);
	assert.ok(existing && typeof existing !== 'string');
	await first.dispose();
	await first.dispose();
	await second.dispose();
	assert.equal((await f.tunnel.tunnels).length, 1);
	await existing.dispose();
	assert.equal(f.children[0].exitCode, 0);
	assert.deepEqual(await f.tunnel.tunnels, []);
});

test('Workbench catalog reads acquire no references and Stop invalidates every acquired handle', async () => {
	const f = fixture();
	using host = f.host;
	using services = f.services;
	const handle = await f.tunnel.openTunnel(undefined, 'localhost', 3000);
	assert.ok(handle && typeof handle !== 'string');
	const catalog = await f.tunnel.tunnels;
	assert.equal(catalog.length, 1);
	assert.equal(f.children[0].exitCode, null);
	await f.tunnel.closeTunnel('::1', 3000);
	await handle.dispose();
	assert.deepEqual(await f.tunnel.tunnels, []);
	assert.equal(await f.tunnel.getExistingTunnel('localhost', 3000), undefined);
	assert.equal(typeof await f.tunnel.openTunnel(undefined, 'public.example', 3000), 'string');
	assert.equal(f.children.length, 1);
	const replacement = await f.tunnel.openTunnel(undefined, 'localhost', 3000);
	assert.ok(replacement && typeof replacement !== 'string');
	await catalog[0].dispose();
	assert.equal(f.children[1].exitCode, null);
	await replacement.dispose();
	assert.deepEqual(await f.tunnel.tunnels, []);
});

test('host close IPC validates identities before changing ownership', async () => {
	const f = fixture();
	using host = f.host;
	using services = f.services;
	await assert.rejects(f.call('close', { id: '' }), /id/);
	await assert.rejects(f.call('close', { id: 'one', host: 'public.example' }), /id/);
	assert.equal(f.children.length, 0);
});

test('tunnel service creation fails immediately when the host boundary is missing', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(TunnelService), /mainProcessService/);
});

class Child extends EventEmitter {
	public exitCode: number | null = null;
	public kill(): boolean {
		if (this.exitCode === null) {
			this.exitCode = 0;
			this.emit('exit', 0);
			this.emit('close', 0);
		}
		return true;
	}
}
