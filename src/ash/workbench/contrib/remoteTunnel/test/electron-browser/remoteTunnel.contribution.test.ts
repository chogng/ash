import assert from 'node:assert/strict';
import { suite, test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Event } from '../../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IRemoteTunnelService, INACTIVE_TUNNEL_MODE, TunnelStates, type IRemoteTunnelService as TunnelService, type ActiveTunnelMode, type TunnelMode, type TunnelStatus } from '../../../../../platform/remoteTunnel/common/remoteTunnel.js';
import { RemoteTunnelCommandIds } from '../../electron-browser/remoteTunnel.contribution.js';

suite('Remote tunnel commands', () => {
	const browser = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	setARIAContainer(browser.window.document.body);
	suiteTeardown(() => browser.window.close());
	test('enable obtains an SSH alias without credentials and does not report cancellation as failure', async () => {
		const calls: ActiveTunnelMode[] = [];
		const errors: string[] = [];
		const service = new Tunnels();
		service.startTunnel = async mode => { calls.push(mode); return TunnelStates.disconnected(); };
		using services = new InstantiationService();
		services.registerInstance(IRemoteTunnelService, service);
		services.registerInstance(IQuickInputService, { input: async () => 'ash-relay', createQuickPick: () => { throw new Error('unused'); } });
		services.registerInstance(IClipboardService, { writeText: async () => undefined } as unknown as IClipboardService);
		services.registerInstance(IDialogService, { error: async (message: string) => { errors.push(message); } } as unknown as IDialogService);
		await services.invokeFunction(accessor => CommandsRegistry.getCommand(RemoteTunnelCommandIds.turnOn)!(accessor));
		assert.deepEqual(calls, [{ active: true, asService: false, session: { providerId: 'ssh', sessionId: 'ash-relay', accountLabel: 'ash-relay' } }]);
		assert.deepEqual(errors, []);
	});
	test('copy uses the relay allocation while preserving the Web host port; stop reaches the owner', async () => {
		using services = new InstantiationService();
		const service = new Tunnels();
		services.registerInstance(IRemoteTunnelService, service);
		let copied = '';
		services.registerInstance(IClipboardService, { writeText: async text => { copied = text; } } as IClipboardService);
		await services.invokeFunction(accessor => CommandsRegistry.getCommand(RemoteTunnelCommandIds.copyToClipboard)!(accessor));
		assert.match(copied, /ssh -N -T -o ExitOnForwardFailure=yes -L 127\.0\.0\.1:5174:127\.0\.0\.1:43123 ash-relay/);
		assert.match(copied, /http:\/\/127\.0\.0\.1:5174\/browser\/workbench\/workbench\.html#ash-ticket=/);
		await services.invokeFunction(accessor => CommandsRegistry.getCommand(RemoteTunnelCommandIds.turnOff)!(accessor));
		assert.equal(service.stopped, true);
	});
});

class Tunnels implements TunnelService {
	declare public readonly _serviceBrand: undefined;
	public readonly onDidChangeTunnelStatus = Event.None;
	public readonly onDidChangeMode = Event.None;
	public readonly onDidTokenFailed = Event.None;
	public stopped = false;
	public async getMode(): Promise<TunnelMode> { return INACTIVE_TUNNEL_MODE; }
	public async getTunnelName(): Promise<string> { return 'ash-relay'; }
	public async initialize(): Promise<TunnelStatus> { return this.getTunnelStatus(); }
	public async getTunnelStatus(): Promise<TunnelStatus> { return TunnelStates.connected({ tunnelName: 'ash-relay', domain: 'ash-relay', tunnelId: '43123', isAttached: false, link: 'http://127.0.0.1:5174/browser/workbench/workbench.html#ash-ticket=' + 'a'.repeat(64) }, false); }
	public async startTunnel(_mode: ActiveTunnelMode): Promise<TunnelStatus> { return this.getTunnelStatus(); }
	public async stopTunnel(): Promise<void> { this.stopped = true; }
}
