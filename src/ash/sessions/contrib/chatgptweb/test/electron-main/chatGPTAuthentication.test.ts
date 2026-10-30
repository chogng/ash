import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { HostCredentialRequest, HostCredentialResponse } from '../../../../../../../.build/protocol/typescript/HostCredentials.js';
import { ChatGPTAuthentication } from '../../electron-main/chatGPTAuthentication.js';
import { ChatGPTAuthenticationError } from '../../common/chatGPTTransport.js';
import { ElectronChatGPTTransport } from '../../electron-browser/electronChatGPTTransport.js';
import { createChatGPTFetch } from '../../browser/chatGPTFetch.js';
import type { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';

const context = 'a'.repeat(32);
const rotatedContext = 'b'.repeat(32);

class Carrier extends EventEmitter {
	public readonly stdin = new PassThrough();
	public readonly stdout = new PassThrough();
	public readonly stderr = new PassThrough();
	public exitCode: number | null = null;
	public killed = false;
	public readonly requests: HostCredentialRequest[] = [];
	constructor(respond: (request: HostCredentialRequest, carrier: Carrier) => void) {
		super();
		let text = '';
		this.stdin.on('data', bytes => {
			text += String(bytes);
			for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n')) {
				const request = JSON.parse(text.slice(0, index)) as HostCredentialRequest;
				text = text.slice(index + 1);
				this.requests.push(request);
				queueMicrotask(() => respond(request, this));
			}
		});
	}
	public send(response: HostCredentialResponse): void { this.stdout.write(JSON.stringify(response) + '\n'); }
	public kill(): boolean { this.killed = true; this.exitCode = 0; this.emit('exit', 0); this.stdin.destroy(); this.stdout.destroy(); this.stderr.destroy(); return true; }
}

function owner(respond: (request: HostCredentialRequest, carrier: Carrier) => void = (request, carrier) => {
	if (request.kind === 'authorize') { carrier.send({ kind: 'authorized', headers: { Authorization: 'Bearer private-owner-token', 'ChatGPT-Account-Id': 'private-owner-account' } }); }
	if (request.kind === 'recover') { carrier.send({ kind: 'recovered', headers: { Authorization: 'Bearer private-rotated-token' } }); }
	if (request.kind === 'release') { carrier.send({ kind: 'released' }); }
}, ready = true): { readonly authentication: ChatGPTAuthentication; readonly carrier: Carrier; } {
	const carrier = new Carrier(respond);
	return {
		carrier, authentication: new ChatGPTAuthentication({
			enabled: true, launcher: {
				description: 'private credential fixture', initializeTimeoutMs: 50,
				validate() { }, launch() {
					if (ready) { queueMicrotask(() => carrier.send({ kind: 'ready', version: 1, context })); }
					return carrier as unknown as ChildProcessWithoutNullStreams;
				},
			}
		})
	};
}

suite('ChatGPT native authentication consumer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('renderer cancellation during the initial owner handshake cannot dispatch a late HTTP request', async () => {
		const ready = new DeferredPromise<string>();
		const entered = new DeferredPromise<void>();
		let requests = 0;
		using transport = new ElectronChatGPTTransport({
			getChannel: () => ({
				listen: () => Event.None,
				call: async (command: string) => {
					if (command === 'authenticationContext') { await entered.complete(); return ready.p; }
					if (command === 'request') { requests++; return { status: 200, headers: {} }; }
					return null;
				},
			})
		} as unknown as IMainProcessService);
		const controller = new AbortController();
		const pending = createChatGPTFetch(transport)('/service/backend-api/models', { signal: controller.signal });
		await entered.p;
		controller.abort();
		await ready.complete(context);
		await assert.rejects(pending);
		assert.equal(requests, 0);
	});
	test('a native authorization and recovery stay private and release their request binding', async () => {
		const fixture = owner();
		using authentication = fixture.authentication;
		assert.equal(await authentication.getContext(), context);
		const lease = await authentication.authorize('aaaa', context, new AbortController().signal);
		assert.equal(lease.headers.get('Authorization'), 'Bearer private-owner-token');
		assert.equal((await lease.recoverUnauthorized())?.get('Authorization'), 'Bearer private-rotated-token');
		lease.dispose();
		await authentication.stop();
		assert.ok(fixture.carrier.killed);
		assert.doesNotMatch(JSON.stringify(fixture.carrier.requests), /private-owner-token|private-rotated-token|refresh_token/u);
	});

	test('owner account routing survives native authorization and recovery', async () => {
		const fixture = owner((request, carrier) => {
			const headers = { Authorization: 'Bearer private-owner-token', 'ChatGPT-Account-Id': 'private-account', 'X-OpenAI-Fedramp': 'true' };
			if (request.kind === 'authorize') { carrier.send({ kind: 'authorized', headers }); }
			if (request.kind === 'recover') { carrier.send({ kind: 'recovered', headers }); }
			if (request.kind === 'release') { carrier.send({ kind: 'released' }); }
		});
		using authentication = fixture.authentication;
		const lease = await authentication.authorize('aaaa', await authentication.getContext(), new AbortController().signal);
		assert.equal(lease.headers.get('X-OpenAI-Fedramp'), 'true');
		assert.equal((await lease.recoverUnauthorized())?.get('X-OpenAI-Fedramp'), 'true');
		lease.dispose();
	});

	test('malformed owner account routing is rejected at the native boundary', async () => {
		const fixture = owner((request, carrier) => {
			if (request.kind === 'authorize') { carrier.send({ kind: 'authorized', headers: { Authorization: 'Bearer private-token', 'X-OpenAI-Fedramp': 'false' } }); }
			if (request.kind === 'release') { carrier.send({ kind: 'released' }); }
		});
		using authentication = fixture.authentication;
		await assert.rejects(authentication.authorize('aaaa', await authentication.getContext(), new AbortController().signal), ChatGPTAuthenticationError);
	});

	test('account changes abort an old lease and reject late authorization replies from its context', async () => {
		const entered = new DeferredPromise<void>();
		const fixture = owner((request, carrier) => {
			if (request.kind === 'authorize') { void entered.complete(); }
			if (request.kind === 'release') { carrier.send({ kind: 'released' }); }
		});
		using authentication = fixture.authentication;
		await authentication.start();
		const changes: (string | undefined)[] = [];
		using listener = authentication.onDidChangeContext(value => changes.push(value));
		const pending = authentication.authorize('aaaa', context, new AbortController().signal);
		await entered.p;
		fixture.carrier.send({ kind: 'changed', context: rotatedContext });
		fixture.carrier.send({ kind: 'authorized', headers: { Authorization: 'Bearer private-stale-token' } });
		await assert.rejects(pending);
		assert.deepEqual(changes, [rotatedContext]);
		assert.equal(await authentication.getContext(), rotatedContext);
		await assert.rejects(authentication.authorize('bbbb', context, new AbortController().signal), ChatGPTAuthenticationError);
	});

	test('cancelling an owner read returns immediately and releases a grant that arrives after cancellation', async () => {
		const entered = new DeferredPromise<void>();
		const released = new DeferredPromise<void>();
		const fixture = owner((request, carrier) => {
			if (request.kind === 'authorize') { void entered.complete(); }
			if (request.kind === 'release') { carrier.send({ kind: 'released' }); void released.complete(); }
		});
		using authentication = fixture.authentication;
		await authentication.start();
		const controller = new AbortController();
		const pending = authentication.authorize('aaaa', context, controller.signal);
		await entered.p;
		controller.abort();
		await assert.rejects(pending);
		fixture.carrier.send({ kind: 'authorized', headers: { Authorization: 'Bearer private-late-token' } });
		await released.p;
	});

	test('closing a consumer while it awaits native readiness ends the wait and its process', async () => {
		const fixture = owner(undefined, false);
		using authentication = fixture.authentication;
		const pending = authentication.start();
		await Promise.resolve();
		await authentication.stop();
		await assert.rejects(pending, ChatGPTAuthenticationError);
		assert.ok(fixture.carrier.killed);
	});

	test('malformed private data is rejected without carrying credential fragments into errors', async () => {
		const fixture = owner((_request, carrier) => carrier.stdout.write('{"kind":"authorized","private":"private-token-fragment"\n'));
		using authentication = fixture.authentication;
		await authentication.start();
		await assert.rejects(authentication.authorize('aaaa', context, new AbortController().signal), error =>
			error instanceof ChatGPTAuthenticationError && !/private-token-fragment/u.test(error.message));
		assert.ok(fixture.carrier.killed);
	});
});
