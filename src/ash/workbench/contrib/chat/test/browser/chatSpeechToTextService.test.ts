import { createTestDictationBackend, installTestDictationAudio, type TestDictationSession, type TestDictationCapture } from '../../../../test/common/testDictationServices.js';
import { IVoiceCodeTranscriptionClient } from '../../browser/speechToText/voiceCodeTranscriptionClient.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { readDictationPreparation, readDictationOptions } from '../../browser/speechToText/dictationInput.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../browser/chat.shared.contribution.js';
import '../../browser/actions/chatSpeechToTextActions.js';
import '../../../speech/browser/speech.contribution.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/renderer/common/dictation.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { ISpeechService, SpeechToTextStatus, type ISpeechToTextEvent } from '../../../speech/common/speechService.js';
import { ILocalTranscriptionService, ILocalTranscriptionModelService, LocalTranscriptionModelState, DictationModelState, type IDictationModelStatus, type ILocalTranscriptionResult, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../../../../services/localTranscription/browser/localTranscriptionService.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FolderConfiguration, WorkspaceConfiguration } from '../../../../services/configuration/browser/configuration.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChatSpeechToTextService, ChatSpeechToTextService, ChatSpeechToTextState, ChatSpeechToTextInProgress, type IChatDictationTranscript } from '../../browser/speechToText/chatSpeechToTextService.js';

suite('Builtin dictation ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const nested of [false, true]) test(`model migration preserves ${nested ? 'workspace' : 'folder'} JSONC and unrelated settings`, async () => {
		using files = new FileService();
		using provider = new InMemoryFileSystemProvider();
		using registration = files.registerProvider('file', provider);
		const resource = URI.file('/workspace/project.json');
		await files.createDirectory(URI.file('/workspace'));
		const settings = '{/* model comment */"dictation.localModel":"custom-model","unrelated":42}';
		const source = nested ? `// workspace comment\n{"folders":[],"settings":${settings},"outside":true}` : settings;
		await files.writeFile({ resource, content: source }, { create: true, overwrite: false });
		const errors: unknown[] = [];
		using configuration = nested ? new WorkspaceConfiguration(resource, files, error => errors.push(error)) : new FolderConfiguration(resource, files, error => errors.push(error));
		await configuration.loadConfiguration();
		const first = await files.readFile(resource);
		assert.equal(configuration.getConfiguration().getValue('dictation.model'), 'custom-model');
		assert.equal(first.content.includes('dictation.localModel'), false);
		assert.ok(first.content.includes('/* model comment */'));
		assert.ok(first.content.includes('"unrelated":42'));
		if (nested) { assert.ok(first.content.startsWith('// workspace comment')); assert.ok(first.content.includes('"outside":true')); }
		await configuration.loadConfiguration();
		assert.equal((await files.readFile(resource)).revision, first.revision);
		assert.deepEqual(errors, []);
	});
	for (const [name, source, expected, error] of [
		['legacy', '{/* retained */"dictation.localModel":"my-model","unrelated":42}', 'my-model', false],
		['target', '{"dictation.model":"my-model","unrelated":42}', 'my-model', false],
		['equal', '{"dictation.localModel":"my-model","dictation.model":"my-model","unrelated":42}', 'my-model', false],
		['conflicting', '{"dictation.localModel":"old-model","dictation.model":"new-model","unrelated":42}', 'new-model', true],
		['invalid', '{"dictation.localModel":"../invalid","unrelated":42}', 'paraformer-large-online-ec6a3c64', true],
	] as const) test(`model setting migration preserves ${name} settings and is restart-idempotent`, async () => {
		const errors: unknown[] = [];
		using configuration = new TestConfigurationService({ source, onError: issue => errors.push(issue) });
		await configuration.reloadConfiguration();
		assert.equal(configuration.getValue('dictation.model'), expected);
		const first = await configuration.read();
		assert.equal(first.source.includes('dictation.localModel'), error);
		assert.ok(first.source.includes('"unrelated":42'));
		if (name === 'legacy') assert.ok(first.source.includes('/* retained */'));
		if (error) assert.equal(first.source, source);
		assert.equal(errors.length > 0, error);
		await configuration.reloadConfiguration();
		assert.deepEqual(await configuration.read(), first);
	});
	const captureWindow = { navigator: {}, URL, Blob, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;

	function services(owner: DisposableStore, start: (onTranscript: (text: string, final: boolean) => void, onEnded: (error?: string) => void) => Promise<TestDictationSession>, options: { source?: string; local?: ILocalTranscriptionService & ILocalTranscriptionModelService; start?: TestDictationCapture['start']; } = {}) {
		const registrations = getSingletonServiceDescriptors().filter(([id]) => id === IChatSpeechToTextService || id === ISpeechService || id === IVoiceCodeTranscriptionClient);
		assert.equal(registrations.length, 3);
		const services = owner.add(new InstantiationService(new ServiceCollection(...registrations)));
		services.registerSingleton(IExtensionService, () => new TestExtensionService());
		services.registerSingleton(IConfigurationService, () => new TestConfigurationService({ source: options.source ?? '{"dictation.backend":"cloud"}' }));
		services.registerSingleton(ILocalTranscriptionService, () => options.local ?? new NullLocalTranscriptionService());
		services.registerSingleton(ILocalTranscriptionModelService, () => options.local ?? new NullLocalTranscriptionService());
		services.registerSingleton(IContextKeyService, () => new ContextKeyService());
		const audio = owner.add(installTestDictationAudio(captureWindow));
		const notifications = owner.add(new NotificationService());
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(ITelemetryService, NullTelemetryService);
		services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(owner, { start: options.start ?? ((_options, onTranscript, onEnded) => start(onTranscript, onEnded)) }));
		const cues: string[] = [];
		services.registerInstance(IAccessibilitySignalService, {
			playSignal: async signal => { cues.push(signal.settingsKey); },
			playSignalLoop: () => Disposable.None,
		});
		const host = owner.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.speechAccessibilitySignal']));
		host.advance(WorkbenchPhase.AfterRestored);
		return {
			services, speech: services.get(IChatSpeechToTextService), cues, audio, notifications,
			preparation: () => readDictationPreparation(services.get(IConfigurationService), services.get(ILocalTranscriptionModelService), services.get(ISpeechService)),
			inputOptions: () => readDictationOptions(captureWindow, services.get(IConfigurationService), services.get(IVoiceCodeTranscriptionBackendService), services.get(ISpeechService)),
		};
	}

	class LocalCapture extends Disposable implements ILocalTranscriptionService, ILocalTranscriptionModelService {
		readonly _serviceBrand = undefined;
		readonly isSupported = true;
		readonly transcribed = this._register(new Emitter<ILocalTranscriptionResult>());
		readonly onDidTranscribe = this.transcribed.event;
		readonly ended = this._register(new Emitter<{ error?: string; }>());
		readonly onDidEnd = this.ended.event;
		readonly onDidChangeModels = Event.None;
		readonly modelStatus = this._register(new Emitter<import("../../../../../platform/localTranscription/common/localTranscription.js").ILocalTranscriptionModelStatus>());
		readonly onDidChangeModelStatus = this.modelStatus.event;
		readonly starts: Parameters<ILocalTranscriptionService['start']>[0][] = [];
		readonly reads: string[] = [];
		cancels = 0;
		pending = Promise.resolve();
		async getModelStatus() { return { state: LocalTranscriptionModelState.Idle }; }
		async getCacheDirectory() { return "C:/models"; }
		async getModel(model: string): Promise<ILocalTranscriptionModelSnapshot> {
			this.reads.push(model);
			return { model, available: true, sizeBytes: 1024 };
		}
		async listModels() { return []; }
		async cancelModel() { assert.fail('Input must not cancel model preparation'); }
		async deleteModel() { assert.fail('Input must not delete models'); }
		prepareModel(): never { assert.fail('Input must not prepare models'); }
		importPackage(): never { assert.fail('Input must not import models'); }
		async importModel(): Promise<never> { assert.fail("Input must not import models"); }
		async start(options: Parameters<ILocalTranscriptionService['start']>[0]) { this.starts.push(options); await this.pending; }
		async pushAudio() { }
		async stop() { this.transcribed.fire({ text: 'final local text', isFinal: true }); this.modelStatus.fire({ state: LocalTranscriptionModelState.Idle }); return 'final local text'; }
		async cancel() { this.cancels++; this.modelStatus.fire({ state: LocalTranscriptionModelState.Idle }); }
	}

	test('switching microphones retains the analyser and releases every track and context on stop', async () => {
		using owner = new DisposableStore();
		const fixture = services(owner, async onTranscript => ({ stop: async () => onTranscript('complete', true), cancel: async () => { } }));
		await fixture.speech.start(captureWindow);
		const analyser = fixture.speech.analyserNode;
		assert.ok(analyser);
		assert.equal(await fixture.speech.switchMicrophone(captureWindow, 'mic-2'), analyser);
		assert.deepEqual(fixture.audio.tracks.map(track => track.stopped), [true, false]);
		assert.equal(fixture.speech.state, ChatSpeechToTextState.Recording);
		assert.deepEqual(fixture.audio.requests[1], { audio: { deviceId: { exact: 'mic-2' }, channelCount: 1 } });
		assert.equal(await fixture.speech.stopAndTranscribe(), 'complete');
		assert.equal(fixture.speech.analyserNode, undefined);
		assert.ok(fixture.audio.tracks.every(track => track.stopped));
		assert.ok(fixture.audio.contexts.every(context => context.state === 'closed'));
	});

	test('failed AudioContext construction releases the microphone and the admitted host session', async () => {
		using owner = new DisposableStore();
		let cancelled = 0;
		const fixture = services(owner, async () => ({ stop: async () => { }, cancel: async () => { cancelled++; } }));
		const descriptor = Object.getOwnPropertyDescriptor(captureWindow, 'AudioContext')!;
		Object.defineProperty(captureWindow, 'AudioContext', { configurable: true, value: class { constructor() { throw new Error('audio initialization failed'); } } });
		try { await assert.rejects(fixture.speech.start(captureWindow), /audio initialization failed/); }
		finally { Object.defineProperty(captureWindow, 'AudioContext', descriptor); }
		await fixture.services.get(IVoiceCodeTranscriptionClient).connect(captureWindow, '');
		assert.equal(cancelled, 1);
		assert.ok(fixture.audio.tracks.every(track => track.stopped));
		assert.equal(fixture.speech.isBusy, false);
	});

	test('preserveLiveTranscript keeps the visible hypothesis when the final result retracts it', async () => {
		using owner = new DisposableStore();
		let transcript!: (text: string, final: boolean) => void;
		const fixture = services(owner, async onTranscript => { transcript = onTranscript; return { stop: async () => onTranscript('short', true), cancel: async () => { } }; });
		await fixture.speech.start(captureWindow);
		transcript('long live transcript', false);
		assert.equal(await fixture.speech.stopAndTranscribe({ preserveLiveTranscript: true }), 'long live transcript');
	});

	test('model preparation events remain indeterminate until inference is ready and reset on cancellation', async () => {
		using owner = new DisposableStore();
		const local = new LocalCapture();
		const ready = new DeferredPromise<void>(); local.pending = ready.p;
		const fixture = services(owner, async () => assert.fail('Unexpected cloud session'), { source: '{"dictation.backend":"local"}', local });
		const preparing: boolean[] = [], downloading: boolean[] = [];
		owner.add(fixture.speech.onDidChangePreparingModel(value => preparing.push(value)));
		owner.add(fixture.speech.onDidChangeDownloadingModel(value => downloading.push(value)));
		const starting = fixture.speech.start(captureWindow);
		local.modelStatus.fire({ state: LocalTranscriptionModelState.Downloading });
		assert.equal(fixture.speech.isPreparingModel, true);
		assert.equal(fixture.speech.modelDownloadProgress, undefined);
		local.modelStatus.fire({ state: LocalTranscriptionModelState.Ready });
		await ready.complete(); await starting;
		await fixture.speech.cancel();
		assert.deepEqual({ preparing, downloading }, { preparing: [true, false], downloading: [true, false] });
	});

	test('selected local model and microphone use the local owner, with lazy preparation reads', async () => {
		using owner = new DisposableStore();
		const local = new LocalCapture();
		const fixture = services(owner, async () => assert.fail('Local capture must not use the cloud adapter'), {
			source: '{"dictation.backend":"local","dictation.model":"custom-online","dictation.inputDevice":"mic-2","dictation.language":"zh"}', local,
		});
		assert.equal(fixture.speech.isConfigured, true);
		assert.deepEqual(local.reads, []);
		assert.equal((await fixture.preparation())?.model, 'custom-online');
		assert.deepEqual(local.reads, ['custom-online']);
		await fixture.speech.start(captureWindow);
		assert.deepEqual(local.starts, [{ cacheDir: 'C:/models', model: 'custom-online' }]);
		assert.equal(await fixture.speech.stopAndTranscribe(), 'final local text');
		assert.equal(fixture.speech.state, ChatSpeechToTextState.Idle);
	});

	test('host failure during acquisition reports once and never opens the microphone', async () => {
		using owner = new DisposableStore();
		const fixture = services(owner, async (_onTranscript, onEnded) => {
			onEnded('recognizer initialization failed');
			return { stop: async () => { }, cancel: async () => { } };
		});
		await assert.rejects(fixture.speech.start(captureWindow), isCancellationError);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
		assert.deepEqual(fixture.audio.requests, []);
		assert.equal(fixture.speech.isBusy, false);
	});

	test('cancelling local acquisition releases its late capture and suppresses text', async () => {
		using owner = new DisposableStore();
		const local = new LocalCapture();
		const ready = new DeferredPromise<void>(); local.pending = ready.p;
		const fixture = services(owner, async () => assert.fail('Unexpected cloud capture'), { source: '{"dictation.backend":"local"}', local });
		const updates: IChatDictationTranscript[] = [];
		owner.add(fixture.speech.onDidUpdateTranscript(event => updates.push(event)));
		const starting = fixture.speech.start(captureWindow);
		const cancelled = fixture.speech.cancel();
		await ready.complete();
		await assert.rejects(starting, isCancellationError); await cancelled;
		local.transcribed.fire({ text: 'late', isFinal: true });
		assert.equal(local.cancels, 1);
		assert.deepEqual(updates, []);
		assert.equal(fixture.speech.isBusy, false);
	});

	for (const [backend, expected] of [
		['cloud', { type: 'cloud', provider: 'xai', modelId: 'grok-voice-transcribe-2.0' }],
		['codex', { type: 'codex' }],
	] as const) {
		test(backend + ' selection resolves configuration before invoking RPC capture', async () => {
			using owner = new DisposableStore();
			let received: unknown;
			const fixture = services(owner, async () => assert.fail('Unexpected capture'), {
				source: JSON.stringify({ 'dictation.backend': backend, 'dictation.cloudProvider': 'xai', 'dictation.inputDevice': 'mic-2', 'dictation.language': 'zh' }),
				start: async options => { received = options; return { stop: async () => { }, cancel: async () => { } }; },
			});
			const speech = fixture.speech;
			assert.equal(await fixture.preparation(), undefined);
			await speech.start(captureWindow);
			assert.deepEqual(received, { backend: expected, language: 'zh' });
			await speech.cancel();
		});
	}

	test('production singleton shares capture across surfaces and flushes final text before Idle', async () => {
		using owner = new DisposableStore();
		let transcript!: (text: string, final: boolean) => void;
		let stops = 0;
		const fixture = services(owner, async (onTranscript, onEnded) => {
			transcript = onTranscript;
			return { stop: async () => { stops++; onTranscript('first second', true); onEnded(); }, cancel: async () => { } };
		});
		const first = owner.add(fixture.services.createChild());
		const second = owner.add(fixture.services.createChild());
		assert.equal(first.get(IChatSpeechToTextService), second.get(IChatSpeechToTextService));
		const observations: string[] = [];
		const updates: IChatDictationTranscript[] = [];
		owner.add(fixture.speech.onDidChangeState(state => observations.push(state)));
		owner.add(fixture.speech.onDidUpdateTranscript(event => { updates.push(event); observations.push(event.text); }));
		await first.get(IChatSpeechToTextService).start(captureWindow, 'editor');
		await assert.rejects(second.get(IChatSpeechToTextService).start(captureWindow, 'terminal'), /already active/);
		assert.equal(fixture.speech.currentSurface, 'editor');
		transcript('first', false); transcript('first draft', false);
		const stopped = fixture.speech.stopAndTranscribe();
		assert.equal(fixture.speech.stopAndTranscribe(), stopped);
		assert.equal(await stopped, 'first second');
		assert.deepEqual(updates, [
			{ text: 'first', finalizedText: '' },
			{ text: 'first draft', finalizedText: '' },
			{ text: 'first second', finalizedText: 'first second' },
		]);
		assert.deepEqual(observations.slice(-3), [ChatSpeechToTextState.Transcribing, 'first second', ChatSpeechToTextState.Idle]);
		assert.equal(stops, 1);
		transcript('late', true); assert.equal(updates.length, 3);
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
	});

	test('cancel during acquisition closes the acquired handle and suppresses final text', async () => {
		using owner = new DisposableStore();
		const acquired = new DeferredPromise<TestDictationSession>();
		let transcript!: (text: string, final: boolean) => void;
		let cancels = 0;
		const fixture = services(owner, onTranscript => { transcript = onTranscript; return acquired.p; });
		const updates: IChatDictationTranscript[] = [];
		owner.add(fixture.speech.onDidUpdateTranscript(event => updates.push(event)));
		const starting = fixture.speech.start(captureWindow);
		assert.equal((fixture.speech.isBusy && fixture.speech.state === ChatSpeechToTextState.Idle), true);
		const cancelled = fixture.speech.cancel();
		await acquired.complete({ stop: async () => assert.fail('Cancelled recording must not flush'), cancel: async () => { cancels++; transcript('discarded', true); } });
		await assert.rejects(starting, isCancellationError); await cancelled;
		assert.equal(cancels, 1); assert.equal(fixture.speech.state, ChatSpeechToTextState.Idle);
		assert.deepEqual(updates, []); assert.deepEqual(fixture.cues, []);
	});

	test('failed acquisition releases ownership without recording cues and permits a retry', async () => {
		using owner = new DisposableStore(); let fail = true;
		const fixture = services(owner, async () => {
			if (fail) throw new Error('microphone unavailable');
			return { stop: async () => { }, cancel: async () => { } };
		});
		await assert.rejects(fixture.speech.start(captureWindow), /microphone unavailable/);
		assert.equal(fixture.speech.isBusy, false); assert.deepEqual(fixture.cues, []);
		fail = false; await fixture.speech.start(captureWindow); await fixture.speech.cancel();
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
	});

	test('synchronous cancel from busy publication never acquires the microphone', async () => {
		using owner = new DisposableStore(); let captures = 0;
		const fixture = services(owner, async () => { captures++; return { stop: async () => { }, cancel: async () => { } }; });
		owner.add(fixture.speech.onDidChangeState(state => {
			if (state === ChatSpeechToTextState.Idle && fixture.speech.isBusy) void fixture.speech.cancel();
		}));
		await assert.rejects(fixture.speech.start(captureWindow), isCancellationError);
		assert.equal(captures, 0); assert.equal(fixture.speech.isBusy, false);
	});

	test('early recognition reaches subscribers and backend failure ends only its recording', async () => {
		using owner = new DisposableStore();
		let ended!: (error?: string) => void;
		let transcript!: (text: string, final: boolean) => void;
		const fixture = services(owner, async (onTranscript, onEnded) => {
			ended = onEnded; transcript = onTranscript;
			return { stop: async () => { }, cancel: async () => { } };
		});
		const updates: IChatDictationTranscript[] = [];
		owner.add(fixture.speech.onDidUpdateTranscript(event => updates.push(event)));
		const notified = new DeferredPromise<void>();
		owner.add(fixture.notifications.model.onDidAdd(() => { void notified.complete(); }));
		await fixture.speech.start(captureWindow); transcript('early', false); ended('connection lost');
		await notified.p; ended('late');
		assert.deepEqual(updates, [{ text: 'early', finalizedText: '' }]);
		assert.deepEqual(fixture.notifications.model.getNotifications().map(item => item.message), ['Dictation failed: Error: connection lost']);
		assert.equal(fixture.speech.isBusy, false);
	});

	test('extension recognition stays in SpeechService and input dictation consumes its public session', async () => {
		using owner = new DisposableStore();
		const fixture = services(owner, async () => assert.fail('An extension provider must not open builtin capture'));
		const events = owner.add(new Emitter<ISpeechToTextEvent>());
		const speech = fixture.services.get(ISpeechService);
		owner.add(speech.registerSpeechProvider('example', {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Example' },
			createSpeechToTextSession: () => ({ onDidChange: events.event }),
			createTextToSpeechSession: () => assert.fail('Unexpected synthesis'),
			createKeywordRecognitionSession: () => assert.fail('Unexpected keyword recognition'),
		}));
		assert.equal(await fixture.inputOptions(), undefined);
		const updates: IChatDictationTranscript[] = [];
		owner.add(fixture.speech.onDidUpdateTranscript(event => updates.push(event)));
		await fixture.speech.start(captureWindow);
		events.fire({ status: SpeechToTextStatus.Started });
		events.fire({ status: SpeechToTextStatus.Recognized, text: 'hello' });
		assert.equal(await fixture.speech.stopAndTranscribe(), 'hello');
		assert.deepEqual(updates, [{ text: 'hello', finalizedText: 'hello' }]);
		assert.equal(speech.hasActiveSpeechToTextSession, false);
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
	});

	test('Cancel command reaches the input owner and clears its window context key', async () => {
		using owner = new DisposableStore(); let cancels = 0;
		const fixture = services(owner, async () => ({ stop: async () => assert.fail('Cancel must discard'), cancel: async () => { cancels++; } }));
		const contexts = fixture.services.get(IContextKeyService);
		await fixture.speech.start(captureWindow, 'terminal');
		assert.equal(contexts.contextMatchesRules(ChatSpeechToTextInProgress.isEqualTo(true)), true);
		const command = CommandsRegistry.getCommand('workbench.action.chat.cancelSpeechToText');
		assert.ok(command);
		await fixture.services.invokeFunction(accessor => command(accessor));
		assert.equal(cancels, 1);
		assert.equal(fixture.speech.isBusy, false);
		assert.equal(contexts.contextMatchesRules(ChatSpeechToTextInProgress.isEqualTo(true)), false);
	});
});
