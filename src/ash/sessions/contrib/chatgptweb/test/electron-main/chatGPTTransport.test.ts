import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
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
