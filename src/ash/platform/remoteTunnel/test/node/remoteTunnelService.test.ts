import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { INACTIVE_TUNNEL_MODE, TunnelStates, type TunnelMode, type TunnelStatus } from '../../common/remoteTunnel.js';
import { RemoteTunnelService } from '../../node/remoteTunnelService.js';
import { ITunnelProcessCoordinator, type ITunnelProcessMachineStatus, type ITunnelProcessStatus } from '../../node/tunnelProcessCoordinator.js';

class Coordinator extends Disposable implements ITunnelProcessCoordinator {
	declare public readonly _serviceBrand: undefined;
	public readonly changed = this._register(new Emitter<ITunnelProcessStatus>());
	public readonly machine = this._register(new Emitter<ITunnelProcessMachineStatus>());
	public readonly onDidChangeStatus = this.changed.event;
	public readonly onDidMachineStatus = this.machine.event;
	public readonly onDidOutput = Event.None;
	public readonly calls: { mode: TunnelMode; root: string | undefined; }[] = [];
	public getStatus(): ITunnelProcessStatus { return { mode: 'none', connectionState: 'disconnected', tunnelName: undefined, serviceInstallFailed: false }; }
	public getIntendedTunnelName(): string { return 'ash-relay'; }
	public async restart(): Promise<void> { }
	public setRemoteAccessStatus(_status: TunnelStatus): void { }
	public async setRemoteAccess(mode: TunnelMode, _level: unknown, root?: string): Promise<void> {
		this.calls.push({ mode, root });
		if (mode.active) {
			this.machine.fire({ mode: 'remoteAccess', status: { type: 'connected', tunnelName: 'ash-relay', isAttached: false, domain: 'ash-relay', tunnelId: '43123', link: 'http://127.0.0.1:5174/' }, cancel() { } });
		} else { this.changed.fire(this.getStatus()); }
	}
}

suite('Application remote tunnel service', () => {
	const mode = { active: true, asService: false, session: { providerId: 'ssh', sessionId: 'ash-relay', accountLabel: 'ash-relay' } } as const;
	test('production injection and authenticated IPC select the caller folder and share the application lease', async () => {
		using coordinator = new Coordinator();
		using services = new InstantiationService(new ServiceCollection([ITunnelProcessCoordinator, coordinator]));
		using owner = services.createInstance(RemoteTunnelService);
		const channel = owner.createChannel(context => {
			if (context !== 'window:1' && context !== 'window:2') { throw new Error('Untrusted window'); }
			return context === 'window:1' ? '/selected' : '/another';
		});
		assert.equal((await channel.call<TunnelStatus>('window:1', 'startTunnel', mode)).type, 'connected');
		assert.deepEqual(coordinator.calls, [{ mode, root: '/selected' }]);
		assert.equal((await channel.call<TunnelStatus>('window:2', 'initialize', INACTIVE_TUNNEL_MODE)).type, 'connected');
		assert.equal(coordinator.calls.length, 1);
		await channel.call('window:2', 'stopTunnel');
		assert.deepEqual(await owner.getMode(), INACTIVE_TUNNEL_MODE);
		assert.deepEqual(await owner.getTunnelStatus(), TunnelStates.disconnected());
	});

	test('rejects roots, credentials, unsupported service installation and unknown callers at the boundary', async () => {
		using coordinator = new Coordinator();
		using services = new InstantiationService(new ServiceCollection([ITunnelProcessCoordinator, coordinator]));
		using owner = services.createInstance(RemoteTunnelService);
		const channel = owner.createChannel(context => { if (context !== 'local' && context !== 'remote') { throw new Error('Untrusted window'); } return context === 'local' ? '/selected' : undefined; });
		for (const value of [{ ...mode, workspaceRoot: '/other' }, { ...mode, asService: true }, { ...mode, session: { ...mode.session, token: 'secret' } }, { ...mode, session: { ...mode.session, sessionId: '-oBad' } }]) {
			await assert.rejects(channel.call('local', 'startTunnel', value));
		}
		await assert.rejects(channel.call('remote', 'startTunnel', mode));
		await assert.rejects(channel.call('unknown', 'getTunnelStatus'));
		assert.equal(coordinator.calls.length, 0);
	});

	test('required coordinator registration fails during construction', () => {
		using services = new InstantiationService(new ServiceCollection());
		assert.throws(() => services.createInstance(RemoteTunnelService));
	});
});
