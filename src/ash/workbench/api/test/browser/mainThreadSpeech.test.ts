import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { ExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { TestExtensionService } from '../../../test/common/testExtensionServices.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { normalizeExtensionHostSnapshot } from '../../../../platform/agentHost/browser/extensionHostProtocol.js';
import type { IExtensionHostApi, ExtensionHostFleetSnapshot, ExtensionHostInvocationRequest, JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { SpeechService } from '../../../contrib/speech/browser/speechService.js';
import { KeywordRecognitionStatus, SpeechToTextStatus, TextToSpeechStatus, type ISpeechToTextEvent, type ISpeechToTextSession, type ISpeechProvider } from '../../../contrib/speech/common/speechService.js';
import { MainThreadSpeech } from '../../browser/mainThreadSpeech.js';

interface Read { readonly request: ExtensionHostInvocationRequest; readonly signal: AbortSignal; readonly result: DeferredPromise<JsonValue>; }
class Host extends Disposable implements IExtensionHostApi {
	private readonly invocationEvent = this._register(new Emitter<ExtensionHostInvocationRequest>());
	public readonly onDidInvoke = this.invocationEvent.event;
	private readonly readEvent = this._register(new Emitter<Read>());
	private readonly waiters = this._register(new DisposableStore());
	private readonly closeEvent = this._register(new Emitter<void>());
	public readonly requests: ExtensionHostInvocationRequest[] = [];
	private readonly reads: Read[] = [];
	public creation: Promise<JsonValue> = Promise.resolve({});
	public onDidChange = Event.None;
	public onConnectionState = Event.None;
	public getConnectionState = async () => 'ready' as const;
	public isAvailable = async () => true;
	public start = async () => snapshot(1);
	public list = async () => snapshot(1);
	public reconcile = async () => snapshot(1);
	public activateByEvent = async () => snapshot(1);
	public registerClientHandler = () => Disposable.None;
	public async invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		this.requests.push(request);
		this.invocationEvent.fire(request);
		if (request.operation === 'createSpeechSession') return this.creation;
		if (request.operation === 'readSpeechSession') {
			const read = { request, signal, result: new DeferredPromise<JsonValue>() };
			this.reads.push(read); this.readEvent.fire(read);
			return read.result.p;
		}
		if (request.operation === 'closeSpeechSession') this.closeEvent.fire();
		return {};
	}
	public async nextRead(): Promise<Read> {
		if (!this.reads.length) await waitFor(this.waiters, this.readEvent.event);
		return this.reads.shift()!;
	}
	public async closed(): Promise<void> {
		if (!this.requests.some(value => value.operation === 'closeSpeechSession')) await waitFor(this.waiters, this.closeEvent.event);
	}
}
function snapshot(incarnation: number, admitted = true): ExtensionHostFleetSnapshot {
	return normalizeExtensionHostSnapshot({
		generation: incarnation, extensions: [{
			id: 'example.speech', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			incarnation, activationGeneration: incarnation, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
			registrations: admitted ? [{ registrationId: 'speech', kind: 'speechProvider', identifier: 'example.recognition' }] : [],
		}]
	});
}
suite('MainThreadSpeech admitted provider lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('standard phrase, synthesis and keyword sessions reach the original registered Host', async () => {
		using owner = new DisposableStore();
		const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech));
		assert.equal(speech.hasSpeechProvider, false); bridge.update(snapshot(1));
		const token = owner.add(new CancellationTokenSource());
		const session = await speech.createSpeechToTextSession(token.token, 'chat');
		const events: ISpeechToTextEvent[] = [];
		owner.add(session.onDidChange(event => events.push(event)));
		const read = await host.nextRead();
		const recognized = waitFor(owner, session.onDidChange, event => event.status === SpeechToTextStatus.Recognized);
		await read.result.complete({ events: [{ status: 1 }, { status: 3, text: 'first' }], closed: false });
		await recognized;
		assert.deepEqual(events, [{ status: SpeechToTextStatus.Started }, { status: SpeechToTextStatus.Recognized, text: 'first' }]);
		await cancelRecognition(owner, session, token); await host.closed();
		assert.deepEqual(events.at(-1), { status: SpeechToTextStatus.Stopped });
		const ttsToken = owner.add(new CancellationTokenSource());
		const tts = await speech.createTextToSpeechSession(ttsToken.token, 'chat');
		const ttsStopped = waitFor(owner, tts.onDidChange, event => event.status === TextToSpeechStatus.Stopped);
		const synthesized = waitFor(owner, host.onDidInvoke, request => request.operation === 'synthesizeSpeech');
		const synthesis = tts.synthesize('hello');
		await synthesized;
		const ttsRead = await host.nextRead();
		await ttsRead.result.complete({ events: [{ status: 1, text: 'hello' }, { status: 2 }], closed: false });
		await ttsStopped;
		await synthesis;
		assert.equal(speech.hasActiveTextToSpeechSession, true); ttsToken.cancel();
		assert.equal(speech.hasActiveTextToSpeechSession, false);
		const keyword = speech.recognizeKeyword(CancellationToken.None);
		const keywordRead = await host.nextRead();
		await keywordRead.result.complete({ events: [{ status: 1 }], closed: false });
		assert.equal(await keyword, KeywordRecognitionStatus.Recognized);
		assert.equal(speech.hasActiveKeywordRecognition, false);
		assert.equal(host.requests.every(request => request.incarnation === 1 && request.activationGeneration === 1 && request.registrationId === 'speech'), true);
		assert.deepEqual(host.requests.find(request => request.operation === 'synthesizeSpeech')!.payload, { sessionId: (ttsRead.request.payload as { sessionId: string; }).sessionId, text: 'hello' });
	});
	test('revocation fences a pending event read and old cancellation cannot stop the replacement', async () => {
		using owner = new DisposableStore(); const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
		const old = owner.add(new CancellationTokenSource());
		const first = await speech.createSpeechToTextSession(old.token);
		const events: ISpeechToTextEvent[] = []; owner.add(first.onDidChange(value => events.push(value)));
		const read = await host.nextRead(); const ended = waitFor(owner, first.onDidChange, value => value.status === SpeechToTextStatus.Stopped);
		bridge.update(snapshot(2)); await ended;
		assert.equal(read.signal.aborted, true);
		await read.result.complete({ events: [{ status: 3, text: 'stale' }], closed: false });
		const current = owner.add(new CancellationTokenSource()); const currentSession = await speech.createSpeechToTextSession(current.token);
		const currentRead = await host.nextRead(); old.cancel();
		assert.equal(speech.hasActiveSpeechToTextSession, true);
		assert.equal(currentRead.signal.aborted, false);
		assert.equal(currentRead.request.incarnation, 2);
		assert.deepEqual(events, [{ status: SpeechToTextStatus.Stopped }]);
		await cancelRecognition(owner, currentSession, current); await currentRead.result.complete({ events: [], closed: true });
	});
	test('invalid provider event rejects the session and closes its exact transport lease', async () => {
		using owner = new DisposableStore(); const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
		const session = await speech.createSpeechToTextSession(CancellationToken.None);
		const failed = waitFor(owner, session.onDidChange, value => value.status === SpeechToTextStatus.Error);
		const read = await host.nextRead(); await read.result.complete({ events: [{ status: 3, text: 42 }], closed: false });
		assert.match((await failed).text!, /Invalid Speech event/); await host.closed();
		assert.equal(speech.hasActiveSpeechToTextSession, false);
	});
	test('cancel during asynchronous creation discards late receipt and closes the original session', async () => {
		using owner = new DisposableStore(); const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
		const receipt = new DeferredPromise<JsonValue>(); host.creation = receipt.p;
		const token = owner.add(new CancellationTokenSource()); const session = await speech.createSpeechToTextSession(token.token);
		await cancelRecognition(owner, session, token); await receipt.complete({});
		await host.closed();
		// Even an invocation implementation which resolves after cancellation cannot publish a session.
		assert.equal(host.requests.some(value => value.operation === 'readSpeechSession'), false);
		const created = host.requests.find(value => value.operation === 'createSpeechSession')!.payload as { sessionId: string; };
		assert.deepEqual(host.requests.find(value => value.operation === 'closeSpeechSession')!.payload, { sessionId: created.sessionId });
		assert.equal(speech.hasActiveSpeechToTextSession, false);
		bridge.update(snapshot(2, false)); assert.equal(speech.hasSpeechProvider, false);
	});
	test('public extension metadata does not replace the exact execution identity used by invocations', async () => {
		using owner = new DisposableStore(); const host = owner.add(new Host());
		const manifestJson = JSON.stringify({ publisher: 'public', name: 'recognition', version: '1', displayName: 'Public recognition' });
		const extensions = owner.add(new TestExtensionService({
			list: async () => ({ generation: 1, diagnostics: [], extensions: [{ id: 'public.recognition', publisher: 'public', name: 'recognition', version: '1', displayName: 'Public recognition', sourceKind: 'user', manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`, packageSha256: `sha256:${'a'.repeat(64)}` }] }),
			resources: new ExtensionResourceLoaderService(async () => assert.fail('Metadata must not read extension resources')),
		})); await extensions.start();
		let metadata: ISpeechProvider['metadata'] | undefined;
		const speech = owner.add(new class extends SpeechService {
			public override registerSpeechProvider(identifier: string, provider: ISpeechProvider) { metadata = provider.metadata; return super.registerSpeechProvider(identifier, provider); }
		}(extensions));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech, extensions));
		const original = snapshot(1); bridge.update({ ...original, extensions: original.extensions.map(runtime => ({ ...runtime, id: 'marketplace:public.recognition:vscode' })) });
		assert.equal(metadata?.extension.value, 'public.recognition'); assert.equal(metadata?.displayName, 'Public recognition');
		const token = owner.add(new CancellationTokenSource()); const session = await speech.createSpeechToTextSession(token.token);
		const read = await host.nextRead();
		assert.equal(read.request.extensionId, 'marketplace:public.recognition:vscode');
		await cancelRecognition(owner, session, token); await read.result.complete({ events: [], closed: true });
	});

	test('synthesis waits for Stopped and reuses the session only after that chunk completes', async () => {
		using owner = new DisposableStore();
		const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
		const token = owner.add(new CancellationTokenSource());
		const session = await speech.createTextToSpeechSession(token.token, 'chat');
		const invoked = waitFor(owner, host.onDidInvoke, request => request.operation === 'synthesizeSpeech');
		let completed = false;
		const synthesis = session.synthesize('first').then(() => { completed = true; });
		await invoked;
		await assert.rejects(session.synthesize('overlapping'), /already in progress/);
		const started = waitFor(owner, session.onDidChange, event => event.status === TextToSpeechStatus.Started);
		const firstRead = await host.nextRead(); await firstRead.result.complete({ events: [{ status: 1 }], closed: false });
		await started; assert.equal(completed, false);
		const stoppedRead = await host.nextRead(); await stoppedRead.result.complete({ events: [{ status: 2 }], closed: false });
		await synthesis; assert.equal(completed, true);
		const secondInvoke = waitFor(owner, host.onDidInvoke, request => request.operation === 'synthesizeSpeech');
		const failed = assert.rejects(session.synthesize('second'), /provider failed/);
		await secondInvoke;
		const secondRead = await host.nextRead(); await secondRead.result.complete({ events: [{ status: 3, text: 'provider failed' }], closed: false });
		await failed;
		assert.equal(host.requests.filter(request => request.operation === 'createSpeechSession').length, 1);
		assert.deepEqual(host.requests.filter(request => request.operation === 'synthesizeSpeech').map(request => (request.payload as { text: string; }).text), ['first', 'second']);
		token.cancel(); await host.closed(); assert.equal(speech.hasActiveTextToSpeechSession, false);
	});

	test('cancel while waiting for synthesized audio ends the exact completion without waiting for a provider event', async () => {
		using owner = new DisposableStore();
		const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
		const token = owner.add(new CancellationTokenSource()); const session = await speech.createTextToSpeechSession(token.token);
		const invoked = waitFor(owner, host.onDidInvoke, request => request.operation === 'synthesizeSpeech');
		const cancelled = assert.rejects(session.synthesize('pending'), isCancellationError);
		await invoked; const read = await host.nextRead(); token.cancel(); await cancelled; await host.closed();
		assert.equal(read.signal.aborted, true); assert.equal(speech.hasActiveTextToSpeechSession, false);
		await read.result.complete({ events: [{ status: 2 }], closed: false });
	});

	test('synthesis failure without provider text uses the installed Chinese translation', async () => {
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			using owner = new DisposableStore();
			const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
			const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
			const token = owner.add(new CancellationTokenSource()); const session = await speech.createTextToSpeechSession(token.token);
			const invoked = waitFor(owner, host.onDidInvoke, request => request.operation === 'synthesizeSpeech');
			const failed = assert.rejects(session.synthesize('你好'), /语音合成失败。/);
			await invoked; await assert.rejects(session.synthesize('正在朗读'), /语音合成正在进行。/);
			const read = await host.nextRead(); await read.result.complete({ events: [{ status: 3 }], closed: false });
			await failed; token.cancel(); await host.closed();
		} finally { resetNlsResolver(); }
	});

	test('clearing the frontend bridge cancels synthesis and closes the still-admitted exact Host session', async () => {
		using owner = new DisposableStore(); const host = owner.add(new Host()); const speech = owner.add(new SpeechService(undefined));
		const bridge = owner.add(new MainThreadSpeech(1000, host, speech)); bridge.update(snapshot(1));
		const old = owner.add(new CancellationTokenSource()); const session = await speech.createTextToSpeechSession(old.token);
		const invoked = waitFor(owner, host.onDidInvoke, request => request.operation === 'synthesizeSpeech');
		const cancelled = assert.rejects(session.synthesize('pending'), isCancellationError);
		await invoked; const read = await host.nextRead(); bridge.clear(); await cancelled; await host.closed();
		assert.equal(read.signal.aborted, true); assert.equal(speech.hasActiveTextToSpeechSession, false);
		const close = host.requests.find(request => request.operation === 'closeSpeechSession')!;
		assert.equal(close.incarnation, 1); assert.equal(close.activationGeneration, 1);
		assert.deepEqual(close.payload, { sessionId: (read.request.payload as { sessionId: string; }).sessionId });
		bridge.update(snapshot(2)); const current = owner.add(new CancellationTokenSource()); const currentSession = await speech.createSpeechToTextSession(current.token);
		const currentRead = await host.nextRead(); old.cancel(); assert.equal(currentRead.signal.aborted, false);
		await read.result.complete({ events: [{ status: 2 }], closed: true });
		await cancelRecognition(owner, currentSession, current); await currentRead.result.complete({ events: [], closed: true });
	});

});

function waitFor<T>(owner: DisposableStore, event: Event<T>, accept: (value: T) => boolean = () => true): Promise<T> {
	const listeners = owner.add(new DisposableStore());
	return new Promise(resolve => {
		listeners.add(event(value => {
			if (accept(value)) { listeners.dispose(); resolve(value); }
		}));
	});
}

async function cancelRecognition(owner: DisposableStore, session: ISpeechToTextSession, source: CancellationTokenSource): Promise<void> {
	const stopped = new Promise<void>(resolve => {
		owner.add(session.onDidChange(event => { if (event.status === SpeechToTextStatus.Stopped) resolve(); }));
	});
	source.cancel();
	await stopped;
}
