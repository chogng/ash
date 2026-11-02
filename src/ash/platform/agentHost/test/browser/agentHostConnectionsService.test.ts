import { URI } from '../../../../base/common/uri.js';
import { remoteAgentHostRoot } from '../../common/remoteAgentHostService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import type { IRendererAgentHostConnection } from '../../../renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../workbench/browser/rendererApi.js';
import { productLanguagePackCatalogs } from '../../../../workbench/services/localization/common/localizationCatalogs.js';
import { AgentHostConnectionsService } from '../../browser/agentHostConnectionsService.js';
import { agentHostConnectionAddress } from '../../common/agentHostConnectionsService.js';
import type { AppServerConnectionState } from '../../common/appServerApi.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('reusing a forwarded Tunnel port cannot reuse a previous authenticated lease resource namespace', () => {
	const target = { type: 'tunnel' as const, name: 'Tunnel', endpoint: 'http://127.0.0.1:5174/', workspace: '/repo' };
	assert.notEqual(remoteAgentHostRoot(target, 'lease-a').authority, remoteAgentHostRoot(target, 'lease-b').authority);
	assert.equal(remoteAgentHostRoot(target, 'lease-a').authority, remoteAgentHostRoot({ ...target, name: 'Renamed' }, 'lease-a').authority);
	assert.throws(() => remoteAgentHostRoot(target), /connection lease/);
});

test('host registry projects the selected ambient host and independent same-server roots without owning their lifetime', async () => {
	using lifetime = new DisposableStore();
	const changed = lifetime.add(new Emitter<void>());
	const state = lifetime.add(new Emitter<AppServerConnectionState>());
	const initialState = new DeferredPromise<AppServerConnectionState>();
	const api = createDisconnectedRendererApi();
	const first = { name: 'First', host: 'build', workspace: '/repo' };
	const nested = { name: 'Nested', host: 'build', workspace: '/repo/nested' };
	let retired = 0;
	const host = { id: 'first', api, connection: first, directory: { uri: URI.parse('ash-remote://ssh+build/repo'), target: { type: 'environment' as const, dirId: 'first' } }, ...toDisposable(() => retired++) };
	lifetime.add(host);
	let entries: IRendererAgentHostConnection[] = [
		{ id: 'first', connection: first, host, state: 'ready' },
		{ id: 'nested', connection: nested, host: undefined, state: 'initializing' },
	];
	const renderer = {
		...api, appServer: { ...api.appServer, getConnectionState: () => initialState.p, onConnectionState: state.event }, agentHosts: {
			get connections() { return entries; }, onDidChangeConnections: changed.event,
			listWSLDistros: async () => [], connect: async () => host, disconnect: () => { throw new Error('Read-only registry must not retire endpoints'); }, reconnect: async () => { },
		}
	};
	const service = lifetime.add(new AgentHostConnectionsService(renderer));
	let updates = 0;
	lifetime.add(service.onDidChangeConnections(() => updates++));
	assert.equal(service.connections[0]!.connection, renderer);
	assert.equal(service.ambientConnection, renderer);
	assert.equal(service.resolveConnection(URI.parse('ash-remote://ssh+build/repo/file.ts'))?.connection, api);
	assert.equal(service.resolveConnection(URI.parse('ash-remote://ssh+build/repo/nested/file.ts'))?.id, 'nested');
	assert.equal(service.resolveConnection(URI.parse('ash-remote://ssh+build/repo/nested/file.ts'))?.connection, undefined);
	assert.throws(() => service.resolveConnection(URI.parse('ash-remote://ssh+build/repository/file.ts')), /Ambiguous/);
	assert.equal(service.resolveConnection(URI.parse('ash-remote://ssh+other/repo/file.ts')), undefined);
	assert.equal(service.resolveConnection(URI.parse('file:///repo/file.ts')), undefined);
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(first))?.connection, api);
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(nested))?.connection, undefined);
	assert.notEqual(service.connections[1]!.authority, service.connections[2]!.authority);
	state.fire('ready');
	await initialState.complete('crashed');
	assert.equal(service.connections[0]!.state, 'ready', 'a late initial read cannot overwrite a newer event');
	entries = [{ ...entries[0]!, state: 'restarting' }];
	changed.fire();
	assert.equal(service.connections[1]!.state, 'restarting');
	assert.equal(service.resolveConnection(URI.parse('ash-remote://ssh+build/other-worktree/file.ts'))?.connection, api);
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(first))?.connection, api, 'recovery keeps the original borrowed domain scope');
	entries = [];
	changed.fire();
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(first))?.connection, undefined);
	assert.equal(service.resolveConnection(URI.parse('ash-remote://ssh+build/repo/file.ts')), undefined);
	assert.equal(updates, 3);
	service.dispose();
	assert.equal(retired, 0);
	changed.fire();
	state.fire('crashed');
	assert.equal(updates, 3);
});

test('ambient host labels follow the Chinese catalog', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		using service = new AgentHostConnectionsService(createDisconnectedRendererApi());
		assert.equal(service.connections[0]!.name, '当前窗口');
	} finally { resetNlsResolver(); }
});

test('Tunnel resource lookup follows the authenticated lease rather than a reused forwarding address', () => {
	using lifetime = new DisposableStore();
	const api = createDisconnectedRendererApi();
	const target = { type: 'tunnel' as const, name: 'Tunnel', endpoint: 'http://127.0.0.1:5174/', workspace: '/repo' };
	const entry = (id: string): IRendererAgentHostConnection => ({
		id, connection: target, state: 'ready', host: lifetime.add({
			id, api, connection: target, ...toDisposable(() => { }),
			directory: { uri: remoteAgentHostRoot(target, id), target: { type: 'environment', dirId: id } },
		}),
	});
	let entries = [entry('lease-a')];
	using service = new AgentHostConnectionsService({
		...api, agentHosts: {
			get connections() { return entries; }, onDidChangeConnections: Event.None,
			connect: async () => { throw new Error('Lookup cannot acquire a host'); },
			disconnect: () => { throw new Error('Lookup cannot release a host'); }, reconnect: async () => { }, listWSLDistros: async () => [],
		},
	});
	const original = remoteAgentHostRoot(target, 'lease-a');
	assert.equal(service.resolveConnection(original)?.id, 'lease-a');
	entries = [entry('lease-b')];
	assert.equal(service.resolveConnection(original), undefined);
	assert.equal(service.resolveConnection(remoteAgentHostRoot(target, 'lease-b'))?.id, 'lease-b');
});
