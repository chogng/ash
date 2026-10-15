import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatGPTTransport } from '../../electron-main/chatGPTTransport.js';
import { createChatGPTFetch } from '../../browser/chatGPTFetch.js';
import { chatGPTAccountHeader, chatGPTAccountScopeHeader } from '../../common/chatGPTTransport.js';
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
	test('keeps credentials in Main, strips response headers and fences external account changes', async () => fixture(async file => {
		const original = await readFile(file, 'utf8');
		const calls: RequestInit[] = [];
		let authorize!: (url: URL) => Promise<Headers>;
		let disposed = 0;
		using transport = new ChatGPTTransport({
			credentialFile: file, readVerificationScript: async () => 'fixture-script', createRuntime: resolver => {
				authorize = resolver;
				return { ...runtime((async (_url, init) => { calls.push(init!); return Response.json({ id: 'fixture' }, { headers: { 'Set-Cookie': 'never-expose' } }); }) as typeof fetch), dispose() { disposed++; } };
			}
		});
		const fetcher = createChatGPTFetch(transport);
		const identity = await fetcher('/service/backend-api/me');
		const binding = identity.headers.get(chatGPTAccountHeader)!;
		assert.ok(binding && !binding.includes('fixture-one'));
		assert.ok(identity.headers.get(chatGPTAccountScopeHeader));
		assert.equal(identity.headers.get('Set-Cookie'), null);
		assert.equal(await identity.text(), '{"id":"fixture"}');
		assert.equal(new Headers(calls[0]!.headers).get('Authorization'), 'Bearer fixture-one');
		assert.equal(calls[0]!.redirect, 'error');
		assert.equal((await authorize(new URL('https://chatgpt.com/backend-api/me'))).get('Authorization'), 'Bearer fixture-one');
		assert.equal((await authorize(new URL('https://other.test/backend-api/me'))).get('Authorization'), '');
		assert.equal((await authorize(new URL('https://chatgpt.com/not-allowed'))).get('Authorization'), '');
		assert.equal(await readFile(file, 'utf8'), original);
		await writeFile(file, JSON.stringify({ tokens: { access_token: 'fixture-two', account_id: 'account-two' } }));
		await assert.rejects(authorize(new URL('https://chatgpt.com/backend-api/sentinel/prepare')), /account changed/);
		const rejected = await fetcher('/service/backend-api/f/conversation', { method: 'POST', headers: { [chatGPTAccountHeader]: binding }, body: '{}' });
		assert.equal(rejected.status, 409); await rejected.text();
		assert.equal(calls.length, 1);
		await (await fetcher('/service/backend-api/me')).text();
		assert.equal(disposed, 1);
	}));
	test('validates IPC routes, methods, headers, sizes and operation shapes', async () => fixture(async file => {
		using transport = new ChatGPTTransport({ credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime(fetch) });
		const channel = transport.getChannel();
		const valid = { path: '/service/backend-api/me', method: 'GET', headers: {} };
		for (const change of [
			{ path: '/service/https://other.test' }, { path: '/service/../not-allowed' }, { path: '/service/backend-api/conversation/%252fsecret' },
			{ path: '/service/backend-api/not-allowed' }, { method: 'DELETE' }, { headers: { Authorization: 'untrusted' } }, { body: 'x' },
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
		const identity = await fetcher('/service/backend-api/me');
		const headers = { [chatGPTAccountHeader]: identity.headers.get(chatGPTAccountHeader)! }; await identity.text();
		const proof = await fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST', headers });
		assert.deepEqual(await proof.json(), { 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
		fail = true;
		const failed = await fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST', headers });
		assert.equal(failed.status, 428); await failed.text();
		assert.equal(calls, 1); assert.equal(disposed, 1);
	}));
	test('cancels pending verification and streamed reads across the pull transport', async () => fixture(async file => {
		let verifying!: () => void, finish!: () => void;
		const started = new Promise<void>(resolve => verifying = resolve);
		const proof = new Promise<unknown>(resolve => finish = () => resolve({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }));
		using transport = new ChatGPTTransport({ credentialFile: file, readVerificationScript: async () => '', createRuntime: () => runtime((async () => Response.json({ id: 'fixture' })) as typeof fetch, async () => { verifying(); return proof; }) });
		const fetcher = createChatGPTFetch(transport);
		const identity = await fetcher('/service/backend-api/me');
		const headers = { [chatGPTAccountHeader]: identity.headers.get(chatGPTAccountHeader)! }; await identity.text();
		const controller = new AbortController();
		const pending = fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST', headers, signal: controller.signal });
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
			const response = await createChatGPTFetch(transport)('/service/backend-api/me');
			assert.equal(response.status, 401); await response.text();
		}
		assert.equal(calls, 0);
	}));
});
