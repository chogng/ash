import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatGPTVoiceSession } from '../../browser/chatGPTVoiceSession.js';

function fixture(microphone?: Promise<MediaStream>) {
	let stopped = 0; let removed = false; let remoteDescriptions = 0;
	const track = { stop() { stopped++; } } as MediaStreamTrack;
	const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
	const channel = {
		readyState: 'connecting', onopen: null as (() => void) | null, onclose: null as (() => void) | null,
		onerror: null as (() => void) | null, onmessage: null as ((event: { data: string; }) => void) | null,
		close() { this.readyState = 'closed'; },
	};
	const peer = {
		connectionState: 'new', localDescription: undefined as RTCSessionDescriptionInit | undefined,
		onconnectionstatechange: null as (() => void) | null, ontrack: null,
		createDataChannel(_name: string, options: RTCDataChannelInit) { assert.deepEqual(options, { negotiated: true, id: 0 }); return channel; },
		addTrack(value: MediaStreamTrack) { assert.equal(value, track); }, addTransceiver() { },
		async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\ns=Offer\r\n' }; },
		async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; },
		async setRemoteDescription(value: RTCSessionDescriptionInit) {
			assert.equal(value.type, 'answer'); remoteDescriptions++;
			this.connectionState = 'connected'; this.onconnectionstatechange?.();
			channel.readyState = 'open'; channel.onopen?.();
		},
		close() { this.connectionState = 'closed'; },
	};
	const audio = { autoplay: false, hidden: false, srcObject: null, setAttribute() { }, async play() { }, pause() { }, remove() { removed = true; } };
	const window = {
		RTCPeerConnection: function () { return peer; },
		document: { createElement: () => audio, body: { append() { } } },
		navigator: { mediaDevices: { getUserMedia: () => microphone ?? Promise.resolve(stream) } },
	} as unknown as Window & typeof globalThis;
	return { window, peer, channel, stream, state: () => ({ stopped, removed, remoteDescriptions }) };
}

suite('ChatGPT WebRTC voice lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('negotiates, projects canonical voice updates and releases every media resource on stop', async () => {
		const f = fixture(); const updates: unknown[] = [];
		using media = new ChatGPTVoiceSession(f.window, event => updates.push(event), error => { throw error; });
		await media.connect(async offer => { assert.match(offer, /^v=0/u); return 'v=0\r\ns=Answer\r\n'; }, new AbortController().signal);
		f.channel.onmessage!({ data: JSON.stringify({ type: 'conversation_update', payload: { conversation_id: 'voice-chat', parent_message_id: 'voice-reply' } }) });
		assert.deepEqual(updates, [{ conversationId: 'voice-chat', parentId: 'voice-reply' }]);
		media.dispose();
		assert.deepEqual(f.state(), { stopped: 1, removed: true, remoteDescriptions: 1 });
		assert.equal(f.channel.onmessage, null); assert.equal(f.channel.readyState, 'closed'); assert.equal(f.peer.connectionState, 'closed');
	});
	test('stopping while permission is pending retires the late microphone and never negotiates', async () => {
		const microphone = new DeferredPromise<MediaStream>(); const f = fixture(microphone.p); const controller = new AbortController();
		using media = new ChatGPTVoiceSession(f.window, () => { }, () => { });
		let negotiations = 0;
		const connecting = media.connect(async () => { negotiations++; return ''; }, controller.signal);
		controller.abort(); await assert.rejects(connecting);
		await microphone.complete(f.stream); await Promise.resolve();
		assert.equal(negotiations, 0); assert.equal(f.state().stopped, 1); assert.equal(f.state().removed, true);
	});
	test('stopping a pending handshake closes audio and rejects a late SDP answer', async () => {
		const answer = new DeferredPromise<string>(); const entered = new DeferredPromise<void>(); const f = fixture(); const controller = new AbortController();
		using media = new ChatGPTVoiceSession(f.window, () => { }, () => { });
		const connecting = media.connect(async () => { await entered.complete(); return answer.p; }, controller.signal);
		await entered.p; controller.abort(); await answer.complete('v=0\r\ns=Late\r\n'); await assert.rejects(connecting);
		assert.deepEqual(f.state(), { stopped: 1, removed: true, remoteDescriptions: 0 });
	});
	test('a rejected service handshake also releases the microphone', async () => {
		const f = fixture(); using media = new ChatGPTVoiceSession(f.window, () => { }, () => { });
		await assert.rejects(media.connect(async () => { throw new Error('Fixture failure'); }, new AbortController().signal), /Fixture failure/u);
		assert.equal(f.state().stopped, 1); assert.equal(f.state().removed, true);
	});
});
