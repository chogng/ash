import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IPCClient } from '../../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { ElectronChatGPTTransport } from '../../electron-browser/electronChatGPTTransport.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatGPTTransport } from '../../electron-main/chatGPTTransport.js';
import { createChatGPTFetch } from '../../browser/chatGPTFetch.js';
import type { IChatGPTVerificationRuntime } from '../../electron-main/chatGPTVerificationRuntime.js';

async function fixture(run: (file: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'ash-chatgpt-transport-'));
	try {
		const file = join(root, 'auth.json');
		await writeFile(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-one', account_id: 'account-one' } }));
		await run(file);
	} finally { await rm(root, { recursive: true, force: true }); }
}
function runtime(fetcher: typeof fetch, prepareHeaders: IChatGPTVerificationRuntime['prepareHeaders'] = async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-proof' })): IChatGPTVerificationRuntime {
	return { session: { fetch: fetcher }, prepareHeaders, dispose() { }, [Symbol.dispose]() { this.dispose(); } };
}

suite('ChatGPT transport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves upload bytes across the actual JSON IPC channel and rejects malformed binary envelopes', async () => fixture(async file => {
		using resources = new DisposableStore();
		const fromRenderer = resources.add(new Emitter<VSBuffer>()), fromMain = resources.add(new Emitter<VSBuffer>());
		const renderer = resources.add(new IPCClient({ onMessage: fromMain.event, send: buffer => queueMicrotask(() => fromRenderer.fire(buffer)) }, 'renderer'));
		const main = resources.add(new IPCClient({ onMessage: fromRenderer.event, send: buffer => queueMicrotask(() => fromMain.fire(buffer)) }, 'main'));
		const bytes = new Uint8Array([0, 128, 255, 137, 80, 78, 71]);
		let received = false;
		const transport = resources.add(new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async (_url, init) => {
				assert.deepEqual(init?.body, bytes); received = true;
				return new Response(null, { status: 201 });
			}) as typeof fetch)
		}));
		main.registerChannel('sessions.chatgpt.transport', transport.getChannel());
		const adapter = new ElectronChatGPTTransport({ getChannel: name => renderer.getChannel(name) } as IMainProcessService);
		const path = '/service/.upload?' + new URLSearchParams({ url: 'https://files.oaiusercontent.com/test?signature=fixture' });
		const response = await createChatGPTFetch(adapter)(path, { method: 'PUT', body: new Blob([bytes]) });
		assert.equal(response.status, 201); await response.text(); assert.equal(received, true);
		for (const body of [{ base64: 'AAAA=' }, { base64: 'AA==garbage' }, { base64: 'AA==', extra: true }, { base64: 'x'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 1) }]) {
			await assert.rejects(renderer.getChannel('sessions.chatgpt.transport').call('request', [randomUUID(), { path, method: 'PUT', headers: {}, body }]), /Invalid ChatGPT upload/u);
		}
	}));

	test('uploads binary bytes only to signed storage and never forwards login or follows redirects', async () => fixture(async file => {
		const calls: RequestInit[] = [];
		using transport = new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async (url, init) => {
				assert.equal(new URL(String(url)).origin, 'https://files.oaiusercontent.com');
				calls.push(init!);
				return new Response(null, { status: 201, headers: { 'Set-Cookie': 'private' } });
			}) as typeof fetch)
		});
		const path = '/service/.upload?' + new URLSearchParams({ url: 'https://files.oaiusercontent.com/test?signature=fixture' });
		const body = VSBuffer.wrap(new Uint8Array([0, 128, 255]));
		const channel = transport.getChannel();
		const id = randomUUID();
		const result = await channel.call('', 'request', [id, { path, method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-ms-blob-type': 'BlockBlob' }, body }]) as { status: number; headers: object; };
		assert.equal(result.status, 201);
		assert.deepEqual(result.headers, {});
		assert.deepEqual([...(calls[0]!.body as Uint8Array)], [0, 128, 255]);
		assert.equal(new Headers(calls[0]!.headers).get('Authorization'), null);
		assert.equal(calls[0]!.credentials, 'omit');
		assert.equal(calls[0]!.redirect, 'error');
		assert.equal(await transport.read(id), null);
		for (const change of [
			{ method: 'POST' }, { body: 'not bytes' }, { body: VSBuffer.alloc(20 * 1024 * 1024 + 1) },
			{ headers: { Authorization: 'private' } }, { headers: { 'x-conduit-token': 'proof' } },
			...['https://chatgpt.com/backend-api/files/test?signature=x', 'https://files.oaiusercontent.com/test', 'https://files.oaiusercontent.com.evil.test/test?signature=x', 'http://127.0.0.1/test?signature=x'].map(url => ({ path: '/service/.upload?' + new URLSearchParams({ url }) })),
		]) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path, method: 'PUT', headers: {}, body, ...change }]), TypeError);
		}
		assert.equal(calls.length, 1);
	}));
	test('reads web resource bytes without forwarding credentials to signed storage or following an unapproved redirect', async () => fixture(async file => {
		const calls: Array<{ url: string; headers: Headers; }> = [];
		using transport = new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async (url, init) => {
				calls.push({ url: String(url), headers: new Headers(init?.headers) });
				if (String(url).includes('redirect')) return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
				return new Response(new Uint8Array([3, 4]), { headers: { 'Content-Type': 'image/png', 'Set-Cookie': 'not-exposed' } });
			}) as typeof fetch)
		});
		const channel = transport.getChannel();
		for (const url of ['https://chatgpt.com/backend-api/files/file-test/download', 'https://files.oaiusercontent.com/file-test?signature=fixture']) {
			const id = randomUUID();
			const response = await channel.call('', 'request', [id, { path: '/service/.resource?' + new URLSearchParams({ url }), method: 'GET', headers: {} }]) as { headers: Record<string, string>; };
			assert.equal(response.headers['content-type'], 'image/png');
			assert.equal(response.headers['Set-Cookie'], undefined);
			assert.deepEqual([...(await transport.read(id))!.buffer], [3, 4]);
			await transport.cancel(id);
		}
		assert.equal(calls[0]!.headers.get('Authorization'), 'Bearer fixture-one');
		assert.equal(calls[1]!.headers.get('Authorization'), null);
		for (const url of ['file:///private', 'https://api.openai.com/v1/files', 'https://chatgpt.com/backend-api/me', 'https://files.oaiusercontent.com.evil.test/file', 'https://files.oaiusercontent.com/redirect']) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path: '/service/.resource?' + new URLSearchParams({ url }), method: 'GET', headers: {} }]), TypeError);
		}
	}));
	test('uses current login credentials only for ChatGPT web requests without binding the chat to an account', async () => fixture(async file => {
		const original = await readFile(file, 'utf8');
		const calls: RequestInit[] = [];
		let authorize!: (url: URL) => Promise<Headers>;
		let disposed = 0;
		using transport = new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => 'fixture-script', createRuntime: resolver => {
				authorize = resolver;
				return {
					...runtime((async (url, init) => {
						assert.equal(new URL(String(url)).origin, 'https://chatgpt.com');
						calls.push(init!);
						return Response.json({ models: [] }, { headers: { 'Set-Cookie': 'never-expose' } });
					}) as typeof fetch), dispose() { disposed++; }
				};
			}
		});
		const fetcher = createChatGPTFetch(transport);
		const first = await fetcher('/service/backend-api/models');
		assert.deepEqual([...first.headers.keys()], ['content-type']);
		await first.text();
		assert.equal(new Headers(calls[0]!.headers).get('Authorization'), 'Bearer fixture-one');
		assert.equal(calls[0]!.redirect, 'error');
		assert.equal((await authorize(new URL('https://chatgpt.com/backend-api/models'))).get('Authorization'), 'Bearer fixture-one');
		assert.equal((await authorize(new URL('https://other.test/backend-api/models'))).get('Authorization'), '');
		assert.equal((await authorize(new URL('https://chatgpt.com/not-allowed'))).get('Authorization'), '');
		assert.equal(await readFile(file, 'utf8'), original);
		await writeFile(file, JSON.stringify({ tokens: { access_token: 'fixture-two', account_id: 'account-two' } }));
		assert.equal((await authorize(new URL('https://chatgpt.com/backend-api/sentinel/prepare'))).get('Authorization'), 'Bearer fixture-two');
		const next = await fetcher('/service/backend-api/f/conversation', { method: 'POST', body: '{}' });
		assert.equal(next.status, 200); await next.text();
		assert.equal(new Headers(calls[1]!.headers).get('Authorization'), 'Bearer fixture-two');
		assert.equal(new Headers(calls[1]!.headers).get('ChatGPT-Account-Id'), 'account-two');
		await writeFile(file, JSON.stringify({ tokens: { access_token: 'fixture-three' } }));
		const current = await authorize(new URL('https://chatgpt.com/backend-api/sentinel/prepare'));
		assert.equal(current.get('Authorization'), 'Bearer fixture-three');
		assert.equal(current.get('ChatGPT-Account-Id'), '');
		assert.equal(disposed, 0);
	}));
	test('sidebar and management routes preserve their HTTP method and reject writes outside the operation contract', async () => fixture(async file => {
		const calls: { method: string; path: string; }[] = [];
		using transport = new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async (url, init) => {
				calls.push({ method: init!.method!, path: new URL(String(url)).pathname });
				return Response.json({ success: true });
			}) as typeof fetch)
		});
		const channel = transport.getChannel();
		for (const [method, path, body] of [
			['GET', '/pins?item_type=conversation', undefined],
			['POST', '/conversation/id/chat/rename', { title: 'Renamed' }],
			['PATCH', '/conversation/chat', { is_starred: true }],
			['PATCH', '/conversation/chat', { is_archived: true }],
			['PATCH', '/conversation/chat', { gizmo_id: 'g-p-project' }],
			['DELETE', '/conversation/id/chat', undefined],
			['POST', '/share/v2/create', { conversation_id: 'chat', current_node_id: 'reply', is_anonymous: true }],
		] as const) {
			const id = randomUUID();
			await channel.call('', 'request', [id, { path: '/service/backend-api' + path, method, headers: {}, ...(body ? { body: JSON.stringify(body) } : {}) }]);
			await channel.call('', 'cancel', [id]);
		}
		assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'PATCH', 'PATCH', 'PATCH', 'DELETE', 'POST']);
		for (const [method, path, body] of [
			['POST', '/pins', '{}'],
			['DELETE', '/models', undefined], ['POST', '/conversation/chat', '{}'], ['PATCH', '/conversation/chat', '{"is_visible":false}'],
			['PATCH', '/conversation/chat', '{"is_starred":true,"gizmo_id":"g-p-project"}'],
			['PATCH', '/conversation/chat', '{"gizmo_id":"../../other"}'], ['DELETE', '/conversation/id/chat', '{}'],
		] as const) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path: '/service/backend-api' + path, method, headers: {}, body }]), TypeError);
		}
		assert.equal(calls.length, 7);
	}));

	test('validates IPC routes, methods, headers, sizes and operation shapes', async () => fixture(async file => {
		using transport = new ChatGPTTransport({ credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime(fetch) });
		const channel = transport.getChannel();
		const valid = { path: '/service/backend-api/models', method: 'GET', headers: {} };
		for (const change of [
			{ path: '/service/https://other.test' }, { path: '/service/../not-allowed' }, { path: '/service/backend-api/conversation/%252fsecret' },
			{ path: '/service/https://api.openai.com/v1/responses' }, { path: '/service/v1/responses' }, { path: '/service/backend-api/me' },
			{ headers: { 'X-Ash-ChatGPT-Account': 'removed-binding' } }, { path: '/service/backend-api/not-allowed' }, { method: 'DELETE' }, { headers: { Authorization: 'untrusted' } }, { body: 'x' },
			{ method: 'POST', path: '/service/backend-api/f/conversation', body: 'x'.repeat(2 * 1024 * 1024 + 1) },
			{ method: 'POST', path: '/service/.headers/backend-api/f/conversation', body: '{}' },
		]) { await assert.rejects(channel.call('', 'request', [randomUUID(), { ...valid, ...change }]), TypeError); }
		await assert.rejects(channel.call('', 'request', ['bad-id', valid]), TypeError);
		await assert.rejects(channel.call('', 'runUiCommand', [randomUUID()]), TypeError);
	}));
	test('filters verification output and retires a failed runtime without sending a message', async () => fixture(async file => {
		let calls = 0, disposed = 0, fail = false;
		using transport = new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => 'fixture-script', createRuntime: () => ({
				...runtime((async () => { calls++; return Response.json({ id: 'fixture' }); }) as typeof fetch, async script => {
					assert.equal(script, 'fixture-script');
					if (fail) { throw new Error('Fixture proof failure'); }
					return { 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof', Authorization: 'never-expose' };
				}), dispose() { disposed++; },
			})
		});
		const fetcher = createChatGPTFetch(transport);
		const proof = await fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST' });
		assert.deepEqual(await proof.json(), { 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
		fail = true;
		const failed = await fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST' });
		assert.equal(failed.status, 428); await failed.text();
		assert.equal(calls, 0); assert.equal(disposed, 1);
	}));
	test('cancels pending verification and streamed reads across the pull transport', async () => fixture(async file => {
		let verifying!: () => void, finish!: () => void;
		const started = new Promise<void>(resolve => verifying = resolve);
		const proof = new Promise<unknown>(resolve => finish = () => resolve({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }));
		using transport = new ChatGPTTransport({ credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async () => Response.json({ id: 'fixture' })) as typeof fetch, async () => { verifying(); return proof; }) });
		const fetcher = createChatGPTFetch(transport);
		const controller = new AbortController();
		const pending = fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST', signal: controller.signal });
		await started; controller.abort();
		await assert.rejects(pending, error => (error as Error).name === 'AbortError' || (error as Error).name === 'Canceled');
		finish();
		assert.equal(await transport.read(randomUUID()), null);
	}));
	test('rejects malformed, oversized or non-chatgpt credential files', async () => fixture(async file => {
		let calls = 0;
		using transport = new ChatGPTTransport({ credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async () => { calls++; return Response.json({}); }) as typeof fetch) });
		for (const content of ['bad JSON', JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'bad' } }), JSON.stringify({ tokens: { access_token: 'bad\nheader' } }), ' '.repeat(1024 * 1024 + 1)]) {
			await writeFile(file, content);
			const response = await createChatGPTFetch(transport)('/service/backend-api/models');
			assert.equal(response.status, 401); await response.text();
		}
		assert.equal(calls, 0);
	}));
});
