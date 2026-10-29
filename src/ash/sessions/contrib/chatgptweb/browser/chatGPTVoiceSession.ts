import { DeferredPromise, raceCancellationError } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { readChatGPTVoiceUpdate, type ChatGPTVoiceUpdate } from './chatGPTClient.js';

/** Owns media and the ChatGPT data channel. The service owns HTTP and conversation state. */
export class ChatGPTVoiceSession extends Disposable {
	private readonly peer: RTCPeerConnection;
	private readonly channel: RTCDataChannel;
	private readonly audio: HTMLAudioElement;
	private readonly ready = new DeferredPromise<void>();
	private microphone: MediaStream | undefined;

	constructor(
		private readonly window: Window & typeof globalThis,
		onUpdate: (update: ChatGPTVoiceUpdate) => void,
		onClosed: (error?: unknown) => void,
	) {
		super();
		this.peer = new window.RTCPeerConnection();
		// ChatGPT negotiates its event channel out of band at id 0.
		this.channel = this.peer.createDataChannel('', { negotiated: true, id: 0 });
		this.audio = window.document.createElement('audio');
		this.audio.autoplay = true;
		this.audio.hidden = true;
		this.audio.setAttribute('aria-hidden', 'true');
		window.document.body.append(this.audio);
		void this.ready.p.catch(() => { });
		const connected = (): void => {
			if (this.peer.connectionState === 'connected' && this.channel.readyState === 'open') { void this.ready.complete(); }
		};
		const failed = (): void => {
			if (this.isDisposed) { return; }
			const error = new Error(localize('sessions.chatgpt.voiceDisconnected', 'The ChatGPT voice connection ended.'));
			void this.ready.error(error); onClosed(error);
		};
		this.peer.onconnectionstatechange = () => {
			connected();
			if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'closed') { failed(); }
		};
		this.channel.onopen = connected;
		this.channel.onclose = failed;
		this.channel.onerror = failed;
		this.channel.onmessage = event => {
			if (this.isDisposed) { return; }
			const update = readChatGPTVoiceUpdate(event.data);
			if (update) { onUpdate(update); }
		};
		this.peer.ontrack = event => {
			if (event.track.kind !== 'audio' || this.isDisposed) { return; }
			this.audio.srcObject = new window.MediaStream([event.track]);
			void this.audio.play().catch(() => {
				if (!this.isDisposed) { onClosed(new Error(localize('sessions.chatgpt.voicePlaybackBlocked', 'Audio playback was blocked. Start voice again from its button.'))); }
			});
		};
		this._register(toDisposable(() => {
			this.peer.onconnectionstatechange = this.peer.ontrack = null;
			this.channel.onopen = this.channel.onclose = this.channel.onerror = this.channel.onmessage = null;
			this.microphone?.getTracks().forEach(track => track.stop());
			this.microphone = undefined;
			this.channel.close(); this.peer.close();
			this.audio.pause(); this.audio.srcObject = null; this.audio.remove();
			void this.ready.error(new CancellationError());
		}));
	}

	async connect(negotiate: (sdp: string, signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const abort = (): void => this.dispose();
		signal.addEventListener('abort', abort, { once: true });
		this._register(toDisposable(() => signal.removeEventListener('abort', abort)));
		const startup = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
		const pending = this.window.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		// Permission may settle after cancellation. Retire that late stream as well.
		void pending.then(stream => { if (this.isDisposed || startup.aborted) { stream.getTracks().forEach(track => track.stop()); } }, () => { });
		try {
			this.microphone = await raceCancellationError(pending, startup);
			startup.throwIfAborted();
			const track = this.microphone.getAudioTracks()[0];
			if (!track) { throw new Error(localize('sessions.chatgpt.voiceMicrophoneMissing', 'No microphone audio track is available.')); }
			this.peer.addTrack(track, this.microphone);
			this.peer.addTransceiver('video', { direction: 'sendonly' });
			await this.peer.setLocalDescription(await this.peer.createOffer());
			startup.throwIfAborted();
			const answer = await negotiate(this.peer.localDescription!.sdp, startup);
			startup.throwIfAborted();
			await this.peer.setRemoteDescription({ type: 'answer', sdp: answer });
			await raceCancellationError(this.ready.p, startup);
		} catch (error) { this.dispose(); throw error; }
	}

	/** Keep playback activation attached to the originating user gesture. */
	unlockAudio(): void { void this.audio.play().catch(() => { }); }
}
