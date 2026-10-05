import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Session, WebContents } from 'electron/main';
import { test } from 'mocha';
import { BrowserSessionPermissions } from '../../electron-main/browserSessionPermissions.js';
import { BrowserSession } from '../../electron-main/browserSession.js';
import { BrowserViewStorageScope, type BrowserViewEvent } from '../../common/browserView.js';
import { SshRemoteTunnelService } from '../../../remote/electron-main/sshRemoteTunnelService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('website grants bind both origins, reset removes decisions and closing cancels without remembering a denial', () => {
	let request!: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
	let check!: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
	const session = Object.assign(new EventEmitter(), {
		setPermissionCheckHandler: (handler: typeof check) => { check = handler; },
		setPermissionRequestHandler: (handler: typeof request) => { request = handler; },
		setDevicePermissionHandler: () => {},
	}) as unknown as Session;
	let pageUrl = 'https://parent.test/';
	const contents = Object.assign(new EventEmitter(), { getURL: () => pageUrl }) as unknown as WebContents;
	const policy = new BrowserSessionPermissions(session);
	const events: BrowserViewEvent[] = [];
	let granted: boolean | undefined;
	const attach = () => policy.attach('page', contents, event => events.push(event));
	let page = attach();
	const ask = () => request(contents, 'geolocation', value => { granted = value; }, { requestingUrl: 'https://frame.test/', isMainFrame: false });
	ask();
	const first = events.find(event => event.type === 'permissionRequested')!;
	assert.equal(first.type, 'permissionRequested');
	if (first.type !== 'permissionRequested') throw new Error('Missing website request');
	assert.throws(() => policy.respond('another-page', first.requestId, true), /Unavailable/);
	policy.respond('page', first.requestId, true);
	assert.equal(granted, true);
	assert.equal(check(contents, 'geolocation', 'https://frame.test/', { isMainFrame: false, embeddingOrigin: 'https://parent.test/' }), true);
	assert.equal(check(contents, 'geolocation', 'https://frame.test/', { isMainFrame: false, embeddingOrigin: 'https://other.test/' }), false);
	policy.clear();
	assert.equal(check(contents, 'geolocation', 'https://frame.test/', { isMainFrame: false, embeddingOrigin: 'https://parent.test/' }), false);
	ask();
	page.dispose();
	assert.equal(granted, false);
	assert.equal(contents.listenerCount('did-start-navigation'), 0);
	page = attach();
	const count = events.filter(event => event.type === 'permissionRequested').length;
	ask();
	assert.equal(events.filter(event => event.type === 'permissionRequested').length, count + 1);
	policy.cancelRequests('page');
	pageUrl = 'about:blank';
	const eventCount = events.length;
	request(contents, 'geolocation', value => { granted = value; }, { requestingUrl: 'about:blank', isMainFrame: true });
	assert.equal(granted, false);
	assert.equal(events.length, eventCount);
	assert.equal(check(contents, 'geolocation', 'null', { isMainFrame: true, embeddingOrigin: 'null' }), false);
	page.dispose();
});

test('a remote session retains one SOCKS policy until its last page closes and never clears it to direct mode', async () => {
	const child = Object.assign(new EventEmitter(), { exitCode: null, stderr: new EventEmitter(), kill: () => { child.emit('exit', 0); return true; } });
	using tunnels = new SshRemoteTunnelService({
		getWorkspace: () => ({ id: 'remote', remoteAuthority: 'ssh+test-host' }),
		sshExecutable: 'ssh', localEnvironment: {}, reserveLocalPort: async () => 12345,
		spawnProcess: (_executable, args) => {
			assert.deepEqual(args.slice(-3), ['-D', '127.0.0.1:12345', 'test-host']);
			return child as unknown as import('node:child_process').ChildProcess;
		},
		probeLoopbackListener: async () => "ready",
	});
	const policies: Electron.ProxyConfig[] = [];
	let connectionsClosed = 0;
	const session = Object.assign(new EventEmitter(), {
		setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {}, setDevicePermissionHandler: () => {},
		setProxy: async (policy: Electron.ProxyConfig) => { policies.push(policy); },
		closeAllConnections: async () => { connectionsClosed++; },
	}) as unknown as Session;
	const owner = BrowserSession.getOrCreate('remote', BrowserViewStorageScope.Workspace, session);
	const first = await owner.acquireRemote(tunnels, new AbortController().signal);
	const second = await owner.acquireRemote(tunnels, new AbortController().signal);
	assert.deepEqual(policies, [{ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:12345', proxyBypassRules: '<-loopback>' }]);
	first.dispose();
	assert.equal(child.listenerCount('exit'), 1);
	child.emit('exit', 1);
	assert.equal(connectionsClosed, 2);
	second.dispose();
	assert.equal(child.listenerCount('exit'), 0);
	assert.equal(policies.length, 1);
});
