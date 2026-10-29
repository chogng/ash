import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
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

test('host registry projects the selected ambient host and independent same-server roots without owning their lifetime', async () => {
	using lifetime = new DisposableStore();
	const changed = lifetime.add(new Emitter<void>());
	const state = lifetime.add(new Emitter<AppServerConnectionState>());
	const initialState = new DeferredPromise<AppServerConnectionState>();
	const api = createDisconnectedRendererApi();
	const first = { name: 'First', host: 'build', workspace: '/repo' };
	const nested = { name: 'Nested', host: 'build', workspace: '/repo/nested' };
	let retired = 0;
	const host = { id: 'first', api, connection: first, ...toDisposable(() => retired++) };
	lifetime.add(host);
	let entries: IRendererAgentHostConnection[] = [
		{ id: 'first', connection: first, host, state: 'ready' },
		{ id: 'nested', connection: nested, host: undefined, state: 'initializing' },
	];
	const renderer = {
		...api,
		appServer: { ...api.appServer, getConnectionState: () => initialState.p, onConnectionState: state.event },
		agentHosts: {
			get connections() {
				return entries;
			},
			onDidChangeConnections: changed.event,
			connect: async () => host,
			disconnect: () => {
				throw new Error('Read-only registry must not retire endpoints');
			},
			reconnect: async () => {},
		},
	};
	const service = lifetime.add(new AgentHostConnectionsService(renderer));
	let updates = 0;
	lifetime.add(service.onDidChangeConnections(() => updates++));
	assert.equal(service.connections[0]!.connection, renderer);
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(first))?.connection, api);
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(nested))?.connection, undefined);
	assert.notEqual(service.connections[1]!.authority, service.connections[2]!.authority);
	state.fire('ready');
	await initialState.complete('crashed');
	assert.equal(service.connections[0]!.state, 'ready', 'a late initial read cannot overwrite a newer event');
	entries = [{ ...entries[0]!, state: 'restarting' }];
	changed.fire();
	assert.equal(service.connections[1]!.state, 'restarting');
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(first))?.connection, api, 'recovery keeps the original borrowed domain scope');
	entries = [];
	changed.fire();
	assert.equal(service.connections.find(entry => entry.address === agentHostConnectionAddress(first))?.connection, undefined);
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
	} finally {
		resetNlsResolver();
	}
});
