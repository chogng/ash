import { ExternalE2EEKeyProvider, Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import workerUrl from 'livekit-client/e2ee-worker?url';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ChatGPTVoiceConnection } from './chatGPTClient.js';

/** Owns one room's media only. ChatGPTService owns its visible lifecycle and conversation. */
export class ChatGPTVoiceSession extends Disposable {
	private readonly room: Room;
	private readonly worker: Worker;
	private readonly keys = new ExternalE2EEKeyProvider();
	private readonly audio = new Map<RemoteTrack, HTMLMediaElement[]>();

	constructor(
		window: Window & typeof globalThis,
		onTranscript: (id: string, text: string, role: 'user' | 'assistant') => void,
		onClosed: (error?: unknown) => void,
	) {
		super();
		this.worker = new window.Worker(workerUrl, { type: 'module' });
		// ChatGPT's room ticket carries the shared media-encryption key.
		this.room = new Room({ e2ee: { keyProvider: this.keys, worker: this.worker }, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		this.room.on(RoomEvent.TrackSubscribed, track => {
			if (track.kind !== Track.Kind.Audio) { return; }
			const element = track.attach();
			element.setAttribute('aria-hidden', 'true');
			element.hidden = true;
			window.document.body.append(element);
			this.audio.set(track, [element]);
		});
		this.room.on(RoomEvent.TrackUnsubscribed, track => {
			track.detach();
			for (const element of this.audio.get(track) ?? []) { element.remove(); }
			this.audio.delete(track);
		});
		this.room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
			if (this.isDisposed) { return; }
			for (const segment of segments) { onTranscript(segment.id, segment.text, participant?.isLocal ? 'user' : 'assistant'); }
		});
		this.room.on(RoomEvent.Disconnected, () => { if (!this.isDisposed) { onClosed(); } });
		this.room.on(RoomEvent.EncryptionError, error => { if (!this.isDisposed) { onClosed(error); } });
		this.room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
			if (!this.isDisposed && !this.room.canPlaybackAudio) { onClosed(new Error(localize('sessions.chatgpt.voicePlaybackBlocked', 'Audio playback was blocked. Start voice again from its button.'))); }
		});
		this._register(toDisposable(() => {
			this.room.removeAllListeners();
			for (const publication of this.room.localParticipant.audioTrackPublications.values()) { publication.track?.stop(); }
			void this.room.disconnect(true);
			for (const [track, elements] of this.audio) { track.detach(); for (const element of elements) { element.remove(); } }
			this.audio.clear();
			this.worker.terminate();
		}));
	}

	async connect(connection: ChatGPTVoiceConnection, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const abort = (): void => this.dispose();
		signal.addEventListener('abort', abort, { once: true });
		this._register(toDisposable(() => signal.removeEventListener('abort', abort)));
		try {
			await this.keys.setKey(connection.encryptionKey);
			signal.throwIfAborted();
			await this.room.setE2EEEnabled(true);
			await this.room.connect(connection.url, connection.token);
			signal.throwIfAborted();
			await this.room.localParticipant.setMicrophoneEnabled(true);
			signal.throwIfAborted();
			await this.room.startAudio();
		} finally {
			// A pending microphone permission may settle after the user has already stopped.
			if (signal.aborted || this.isDisposed) { await this.room.disconnect(true); }
		}
	}

	/** Call from the originating click so autoplay can be unlocked before network I/O. */
	unlockAudio(): void { void this.room.startAudio().catch(() => { }); }
}
