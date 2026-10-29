import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { AppServerWebWorkspaceClient } from '../../browser/appServerWebWorkspaceClient.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';

function fixture() {
	const entries = new Map<string, string>();
	const storage: Storage = { get length() { return entries.size; }, clear: () => entries.clear(), getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: key => { entries.delete(key); }, key: index => [...entries.keys()][index] ?? null };
	const target = { sessionStorage: storage } as unknown as Window;
	const endpoint = new URL('http://127.0.0.1:5174/');
	const initial = { id: 'first', configuration: null, folders: [{ id: 'first', path: '/first', name: null }] };
	const next = { id: 'file:///first/team.ash-workspace', configuration: 'file:///first/team.ash-workspace', folders: [{ id: 'second', path: '/second', name: 'Second' }] };
	return { storage, target, endpoint, initial, next };
}

test('Web workspace Finish response loss preserves the recorded UI outcome for page recovery', async () => {
	const state = fixture();
	const originalFetch = globalThis.fetch;
	const requests: Array<{ operation: string; accepted?: boolean; }> = [];
	let disconnected = true;
	globalThis.fetch = async (_input, options) => {
		assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer token');
		const request = JSON.parse(String(options?.body));
		requests.push(request);
		if (request.operation === 'finish' && disconnected) throw new TypeError('connection lost');
		return Response.json(state.next);
	};
	try {
		const client = new AppServerWebWorkspaceClient(state.endpoint, 'token', state.target, state.initial);
		const transition = await client.updateWorkspace(URI.parse(state.next.configuration), [{ path: '/second', name: 'Second' }]);
		assert.equal(transition.workspace.folders[0]?.id, 'second');
		await assert.rejects(transition.complete(true), /connection lost/);
		assert.deepEqual(requests.map(request => [request.operation, request.accepted]), [['apply', undefined], ['finish', true], ['finish', true]]);
		assert.equal(JSON.parse(state.storage.getItem('ash.appServer.workspaceTransaction:http://127.0.0.1:5174')!).accepted, true);
		disconnected = false;
		const reloaded = new AppServerWebWorkspaceClient(state.endpoint, 'token', state.target, state.initial);
		await reloaded.recoverPending();
		assert.equal(reloaded.getInitialWorkspace()?.folders[0]?.id, 'second');
		assert.equal(state.storage.length, 0);
		assert.equal(requests.at(-1)?.accepted, true);
	} finally { globalThis.fetch = originalFetch; }
});

test('Web workspace lost Apply response explicitly restores its previous authorization before returning failure', async () => {
	const state = fixture();
	const originalFetch = globalThis.fetch;
	const operations: string[] = [];
	globalThis.fetch = async (_input, options) => {
		const request = JSON.parse(String(options?.body));
		operations.push(request.operation);
		if (request.operation === 'apply') throw new TypeError('response lost after apply');
		assert.equal(request.accepted, false);
		return Response.json(state.initial);
	};
	try {
		const client = new AppServerWebWorkspaceClient(state.endpoint, 'token', state.target, state.initial);
		await assert.rejects(client.updateWorkspace(URI.parse(state.next.configuration), [{ path: '/second', name: 'Second' }]), /response lost after apply/);
		assert.deepEqual(operations, ['apply', 'finish']);
		assert.equal(state.storage.length, 0);
		assert.equal(client.getInitialWorkspace()?.id, 'first');
	} finally { globalThis.fetch = originalFetch; }
});

test('Web workspace recovery failure uses the Chinese client translation', async () => {
	const state = fixture();
	state.storage.setItem('ash.appServer.workspaceTransaction:http://127.0.0.1:5174', '{}');
	await initializeTestLocalization('zh-CN');
	try {
		const client = new AppServerWebWorkspaceClient(state.endpoint, 'token', state.target, state.initial);
		await assert.rejects(client.recoverPending(), /无法恢复已保存的工作区切换/);
	} finally { resetNlsResolver(); }
});

test('Web workspace denied server authorization uses Chinese text and clears only the failed transaction', async () => {
	const state = fixture();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, options) => JSON.parse(String(options?.body)).operation === 'apply'
		? new Response('Directory authorization declined', { status: 403 })
		: new Response('Unknown workspace transaction', { status: 400 });
	await initializeTestLocalization('zh-CN');
	try {
		const client = new AppServerWebWorkspaceClient(state.endpoint, 'token', state.target, state.initial);
		await assert.rejects(client.updateWorkspace(URI.parse(state.next.configuration), [{ path: '/second', name: 'Second' }]), /服务器未授权此次工作区更改/);
		assert.equal(state.storage.length, 0);
	} finally { globalThis.fetch = originalFetch; resetNlsResolver(); }
});
