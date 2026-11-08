import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IAgentVoiceService } from '../../../platform/agentHost/common/agentService.js';
import { IVoiceInputModeService, VoiceInputModeService } from '../../contrib/chat/browser/voiceInputMode/voiceInputMode.js';
import { CommandService } from '../../services/commands/common/commandService.js';
import { ILocalTranscriptionService, ILocalTranscriptionModelService } from '../../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../../services/localTranscription/browser/localTranscriptionService.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { ChatContextService, IChatContextService } from '../../contrib/chat/browser/contextContrib/chatContextService.js';
import { ChatContextPickService, IChatContextPickService } from '../../contrib/chat/browser/attachments/chatContextPickService.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { darkColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { TestExtensionService } from './testExtensionServices.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../services/storage/browser/storageService.js';
import { DictationOnboardingService, IDictationOnboardingService } from '../../contrib/chat/browser/speechToText/dictationOnboarding.js';
import { ChatInputNoticeHubService, IChatInputNoticeHubService } from '../../contrib/chat/browser/widget/input/chatInputNoticeHub.js';
import { ChatInputNotificationService, IChatInputNotificationService } from '../../contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { IVoiceModeOnboardingService, VoiceModeOnboardingService } from '../../contrib/agentsVoice/browser/voiceModeOnboarding.js';
import { AgentsVoiceStorageKeys } from '../../contrib/agentsVoice/common/agentsVoice.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from '../../contrib/chat/browser/speechToText/voiceCodeTranscriptionClient.js';
import { IVoiceCodeTranscriptionBackendService, type DictationBackend, type IDictationInputOptions } from '../../../platform/dictation/common/dictation.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../platform/telemetry/common/telemetryUtils.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { PCM_FLUSH_ACK } from '../../contrib/chat/browser/pcmCaptureWorklet.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../services/notification/test/common/testNotificationService.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';

export interface TestDictationSession { stop(): Promise<void>; cancel(): Promise<void>; }
export interface TestDictationCapture {
	getOptions?(backend: DictationBackend): Promise<IDictationInputOptions>;
	start(options: { readonly backend: DictationBackend; readonly language: string | null; }, onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<TestDictationSession>;
}

/** Admits fake recognition at the host boundary while exercising the production transcription client. */
export function createTestDictationBackend(owner: DisposableStore, capture: TestDictationCapture): IVoiceCodeTranscriptionBackendService {
	const transcript = owner.add(new Emitter<{ resourceId: string; text: string; isFinal: boolean; }>());
	const ended = owner.add(new Emitter<{ resourceId: string; error?: string; }>());
	const sessions = new Map<string, { handle: Promise<TestDictationSession>; text?: string; cancelling?: Promise<void>; }>();
	return {
		isConnected: true, onDidChangeConnection: Event.None, onDidTranscribe: transcript.event, onDidEnd: ended.event,
		readInstructions: async () => { throw new Error('This recording fixture does not provide Profile instructions'); },
		writeInstructions: async () => { throw new Error('This recording fixture does not provide Profile instructions'); },
		getOptions: capture.getOptions ?? (async () => ({ inputDevices: [], languages: [] })),
		start: async (resourceId, options) => {
			const entry = {
				handle: Promise.resolve().then(() => capture.start(options, (text, isFinal) => {
					entry.text = text;
					transcript.fire({ resourceId, text, isFinal });
				}, error => ended.fire({ resourceId, error }))), text: undefined as string | undefined
			};
			sessions.set(resourceId, entry);
			await entry.handle;
		},
		pushAudio: async () => { },
		stop: async resourceId => {
			const entry = sessions.get(resourceId);
			if (!entry) return undefined;
			await (await entry.handle).stop();
			sessions.delete(resourceId);
			return entry.text;
		},
		cancel: async resourceId => {
			const entry = sessions.get(resourceId);
			if (!entry) return;
			await (entry.cancelling ??= entry.handle.then(handle => handle.cancel()));
			sessions.delete(resourceId);
		},
	};
}

/** Scoped browser-device fixture; capture processing and client delivery still use production code. */
export function installTestDictationAudio(target: Window & typeof globalThis): IDisposable & { emit(samples: Float32Array): void; setLevel(level: number): void; readonly levelReads: number; readonly requests: MediaStreamConstraints[]; readonly tracks: { stopped: boolean; }[]; readonly contexts: { state: string; }[]; } {
	const lifetime = new DisposableStore();
	const ports: { onmessage: MessagePort['onmessage']; postMessage(message: unknown): void; }[] = [];
	const requests: MediaStreamConstraints[] = [];
	const tracks: { stopped: boolean; }[] = [];
	const contexts: { state: string; }[] = [];
	let level = 0;
	let levelReads = 0;
	const replace = (object: object, key: string, value: unknown): void => {
		const previous = Object.getOwnPropertyDescriptor(object, key);
		Object.defineProperty(object, key, { configurable: true, value });
		lifetime.add(toDisposable(() => { if (previous) Object.defineProperty(object, key, previous); else Reflect.deleteProperty(object, key); }));
	};
	class AudioNode { connect() { return this; } disconnect() { } }
	class Analyser extends AudioNode {
		readonly fftSize = 2048;
		getByteTimeDomainData(samples: Uint8Array): void {
			levelReads++;
			samples.fill(Math.round(128 + level * 127));
		}
	}
	class Context {
		constructor() { contexts.push(this); }
		state = 'running';
		readonly destination = new AudioNode();
		readonly audioWorklet = { addModule: async () => { } };
		createAnalyser() { return new Analyser(); }
		createMediaStreamSource() { return new AudioNode(); }
		async resume() { }
		async close() { this.state = 'closed'; }
	}
	class Worklet extends AudioNode {
		readonly port = {
			onmessage: null as MessagePort['onmessage'],
			postMessage: () => { queueMicrotask(() => this.port.onmessage?.call(this.port as unknown as MessagePort, { data: { type: PCM_FLUSH_ACK } } as MessageEvent)); },
		};
		constructor() { super(); ports.push(this.port); }
	}
	replace(target, 'AudioContext', Context);
	replace(target, 'AudioWorkletNode', Worklet);
	replace(target.URL, 'createObjectURL', () => 'blob:dictation-test');
	replace(target.URL, 'revokeObjectURL', () => { });
	replace(target.navigator, 'mediaDevices', Object.assign(new (target.EventTarget ?? EventTarget)(), {
		enumerateDevices: async () => [{ deviceId: 'mic-2', kind: 'audioinput', label: 'USB microphone' }, { deviceId: 'microphone-1', kind: 'audioinput', label: 'Test microphone (Built-in)' }],
		getUserMedia: async (constraints: MediaStreamConstraints) => {
			requests.push(constraints);
			const track = { stopped: false, stop() { this.stopped = true; } };
			tracks.push(track);
			return { getTracks: () => [track] };
		},
	}));
	return {
		requests, tracks, contexts,
		setLevel: value => { level = value; },
		get levelReads() { return levelReads; },
		emit: samples => { for (const port of ports) port.onmessage?.call(port as unknown as MessagePort, { data: samples } as MessageEvent); },
		dispose: () => lifetime.dispose(),
		[Symbol.dispose]: () => lifetime.dispose(),
	};
}

/** Test profile storage is isolated from the browser's persistent user profile. */
export function registerTestDictationOnboarding(services: InstantiationService, seen = true): void {
	if (!services.has(IAgentVoiceService)) services.registerInstance(IAgentVoiceService, undefined);
	if (!services.has(IVoiceInputModeService)) services.registerSingleton(IVoiceInputModeService, () => services.createInstance(VoiceInputModeService));
	if (!services.has(IChatInputNoticeHubService)) services.registerSingleton(IChatInputNoticeHubService, () => services.createInstance(ChatInputNoticeHubService));
	if (!services.has(IChatInputNotificationService)) services.registerSingleton(IChatInputNotificationService, () => services.createInstance(ChatInputNotificationService));
	if (!services.has(IVoiceModeOnboardingService)) services.registerSingleton(IVoiceModeOnboardingService, () => services.createInstance(VoiceModeOnboardingService));
	if (!services.has(ICommandService)) services.registerSingleton(ICommandService, () => services.invokeFunction(accessor => new CommandService(accessor)));
	if (!services.has(ILogService)) services.registerInstance(ILogService, new NullLoggerService());
	if (!services.has(IVoiceCodeTranscriptionBackendService)) services.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	if (!services.has(IVoiceCodeTranscriptionClient)) services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
	if (!services.has(ITelemetryService)) services.registerInstance(ITelemetryService, NullTelemetryService);
	if (!services.has(INotificationService)) services.registerSingleton(INotificationService, () => new TestNotificationService());
	if (!services.has(ILocalTranscriptionModelService)) services.registerSingleton(ILocalTranscriptionModelService, () => new NullLocalTranscriptionService());
	if (!services.has(ILocalTranscriptionService)) services.registerSingleton(ILocalTranscriptionService, () => new NullLocalTranscriptionService());
	if (!services.has(IConfigurationService)) services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	if (!services.has(IContextKeyService)) services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	if (!services.has(IExtensionService)) services.registerSingleton(IExtensionService, () => new TestExtensionService());
	if (!services.has(IChatContextPickService)) services.registerSingleton(IChatContextPickService, () => new ChatContextPickService());
	if (!services.has(IChatContextService)) services.registerSingleton(IChatContextService, () => services.createInstance(ChatContextService));
	if (!services.has(IThemeService)) services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	if (!services.has(IStorageService)) {
		const entries = new Map<string, string>();
		services.registerSingleton(IStorageService, () => new BrowserStorageService({
			ownerWindow: window, profileId: 'dictation-test', workspaceId: 'test', flushInterval: 0, backend: {
				get length() { return entries.size; }, clear: () => entries.clear(), key: index => [...entries.keys()][index] ?? null,
				getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: key => { entries.delete(key); },
			}
		}));
	}
	if (seen) services.get(IStorageService).store('dictation.introductionSeen', true, StorageScope.PROFILE, StorageTarget.USER);
	if (seen) services.get(IStorageService).store(AgentsVoiceStorageKeys.IntroBannerShown, true, StorageScope.PROFILE, StorageTarget.USER);
	services.registerSingleton(IDictationOnboardingService, () => services.createInstance(DictationOnboardingService));
}
