import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import '../../../../contrib/accessibility/browser/accessibilityConfiguration.js';
import '../../../chat/browser/actions/chatSpeechToTextActions.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { createHash } from 'node:crypto';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { SpeechService } from '../../browser/speechService.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import '../../browser/speech.contribution.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IDictationService, type IDictationSession } from '../../../../../platform/dictation/common/dictationService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { ISpeechService, SpeechToTextState, SpeechToTextStatus, type ISpeechToTextEvent, type ISpeechProvider, KeywordRecognitionStatus, SPEECH_LANGUAGE_CONFIG, speechLanguageConfigToLanguage } from '../../common/speechService.js';

suite('Workbench speech ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function services(owner: DisposableStore, start: IDictationService['start']) {
		const registrations = getSingletonServiceDescriptors().filter(([id]) => id === ISpeechService);
		assert.equal(registrations.length, 1);
		const services = owner.add(new InstantiationService(new ServiceCollection(...registrations)));
		services.registerSingleton(IExtensionService, () => new TestExtensionService());
		services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
		services.registerSingleton(IContextKeyService, () => new ContextKeyService());
		services.registerInstance(IDictationService, {
			onDidChangePreparation: Event.None,
			getPreparation: async () => undefined,
			prepareModel: async () => { },
			cancelPreparation: async () => { },
			getOptions: async () => ({ inputDevices: [], languages: [] }),
			start,
		});
		const cues: string[] = [];
		services.registerInstance(IAccessibilitySignalService, {
			playSignal: async signal => { cues.push(signal.settingsKey); },
			playSignalLoop: () => Disposable.None,
		});
		const host = owner.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.speechAccessibilitySignal']));
		host.advance(WorkbenchPhase.AfterRestored);
		return { services, cues, speech: services.get(ISpeechService), host };
	}

	test('production registration shares capture across consumers and flushes the final phrase before idle', async () => {
		using owner = new DisposableStore();
		let transcript!: (text: string, isFinal: boolean) => void;
		let ended!: (error?: string) => void;
		let stops = 0;
		const fixture = services(owner, async (onTranscript, onEnded) => {
			transcript = onTranscript;
			ended = onEnded;
			return { stop: async () => { stops++; transcript('second', true); ended(); }, cancel: async () => { stops++; } };
		});
		assert.equal(fixture.speech.hasSpeechProvider, false);
		const first = owner.add(fixture.services.createChild());
		const second = owner.add(fixture.services.createChild());
		assert.equal(first.get(ISpeechService), second.get(ISpeechService));
		const updates: ISpeechToTextEvent[] = [];
		const observations: (SpeechToTextState | string)[] = [];

		owner.add(fixture.speech.onDidChangeState(state => observations.push(state)));
		const session = await first.get(ISpeechService).createSpeechToTextSession(CancellationToken.None);
		owner.add(session.onDidChange(event => { if (event.text !== undefined) { updates.push(event); observations.push(event.text); } }));
		await assert.rejects(second.get(ISpeechService).createSpeechToTextSession(CancellationToken.None), /Dictation is already active/);
		transcript('first', true);
		transcript('draft', false);
		const stopped = fixture.speech.stopAndTranscribe();
		assert.equal(fixture.speech.stopAndTranscribe(), stopped);
		assert.equal(await stopped, 'first second');
		assert.deepEqual(updates, [
			{ status: SpeechToTextStatus.Recognized, text: 'first' },
			{ status: SpeechToTextStatus.Recognizing, text: 'draft' },
			{ status: SpeechToTextStatus.Recognized, text: 'second' },
		]);
		assert.deepEqual(observations.slice(-3), [SpeechToTextState.Transcribing, 'second', SpeechToTextState.Idle]);
		assert.equal(stops, 1);
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
		fixture.host.dispose();
		await fixture.speech.createSpeechToTextSession(CancellationToken.None);
		await fixture.speech.cancel();
		assert.equal(fixture.cues.length, 2);
	});

	test('cancel while acquiring the microphone closes the acquired session and discards its final text', async () => {
		using owner = new DisposableStore();
		let acquired!: (session: IDictationSession) => void;
		let transcript!: (text: string, isFinal: boolean) => void;
		let stops = 0;
		const fixture = services(owner, onTranscript => {
			transcript = onTranscript;
			return new Promise(resolve => { acquired = resolve; });
		});

		const starting = fixture.speech.createSpeechToTextSession(CancellationToken.None);
		assert.equal(fixture.speech.isStarting, true);
		const cancelled = fixture.speech.cancel();
		acquired({ stop: async () => { stops++; transcript('discarded', true); }, cancel: async () => { stops++; } });
		await assert.rejects(starting, isCancellationError);
		await cancelled;
		assert.equal(stops, 1);
		assert.equal(fixture.speech.state, SpeechToTextState.Idle);
		assert.deepEqual(fixture.cues, []);
	});

	test('failed microphone acquisition releases capture without announcing a recording', async () => {
		using owner = new DisposableStore();
		let fail = true;
		const fixture = services(owner, async () => {
			if (fail) { throw new Error('microphone unavailable'); }
			return { stop: async () => { }, cancel: async () => { } };
		});
		await assert.rejects(fixture.speech.createSpeechToTextSession(CancellationToken.None), /microphone unavailable/);
		assert.equal(fixture.speech.state, SpeechToTextState.Idle);
		assert.deepEqual(fixture.cues, []);
		fail = false;
		await fixture.speech.createSpeechToTextSession(CancellationToken.None);
		await fixture.speech.cancel();
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
	});
	test('a pre-cancelled token never opens media, and a rejected busy caller cannot cancel the actual owner', async () => {
		using owner = new DisposableStore();
		let starts = 0; let stops = 0;
		const fixture = services(owner, async () => { starts++; return { stop: async () => { stops++; }, cancel: async () => { stops++; } }; });
		using preCancelled = new CancellationTokenSource(); preCancelled.cancel();
		await assert.rejects(fixture.speech.createSpeechToTextSession(preCancelled.token), isCancellationError);
		assert.equal(starts, 0);
		using first = new CancellationTokenSource();
		await fixture.speech.createSpeechToTextSession(first.token, 'chat');
		using rejected = new CancellationTokenSource();
		await assert.rejects(fixture.speech.createSpeechToTextSession(rejected.token, 'editor'), /already active/);
		rejected.cancel();
		assert.equal(stops, 0);
		assert.equal(fixture.speech.hasActiveSpeechToTextSession, true);
		await fixture.speech.stopAndTranscribe();
		await fixture.speech.createSpeechToTextSession(CancellationToken.None, 'terminal');
		first.cancel();
		assert.equal(stops, 1);
		await fixture.speech.stopAndTranscribe();
		assert.equal(stops, 2);
	});

	test('session buffers early recognition, delivers final flush before Stopped, and retires its event source', async () => {
		using owner = new DisposableStore();
		let transcript!: (text: string, isFinal: boolean) => void;
		const fixture = services(owner, async onTranscript => {
			transcript = onTranscript;
			onTranscript('early', true); onTranscript('pending', false);
			return { stop: async () => { onTranscript('final', true); }, cancel: async () => { } };
		});
		const session = await fixture.speech.createSpeechToTextSession(CancellationToken.None, 'chat');
		const events: ISpeechToTextEvent[] = [];
		owner.add(session.onDidChange(event => events.push(event)));
		assert.deepEqual(events, [
			{ status: SpeechToTextStatus.Started },
			{ status: SpeechToTextStatus.Recognized, text: 'early' },
			{ status: SpeechToTextStatus.Recognizing, text: 'pending' },
		]);
		await fixture.speech.stopAndTranscribe();
		assert.deepEqual(events.slice(-2), [
			{ status: SpeechToTextStatus.Recognized, text: 'final' },
			{ status: SpeechToTextStatus.Stopped },
		]);
		transcript('late', true);
		assert.equal(events.length, 5);
	});

	test('provider registration controls availability and ambiguity before acquiring any session', async () => {
		using owner = new DisposableStore(); const speech = owner.add(new SpeechService(undefined));
		const changes: boolean[] = []; owner.add(speech.onDidChangeHasSpeechProvider(() => changes.push(speech.hasSpeechProvider)));
		const provider: ISpeechProvider = {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: () => assert.fail('Ambiguous capture must not start'),
			createTextToSpeechSession: () => assert.fail('Ambiguous synthesis must not start'),
			createKeywordRecognitionSession: () => assert.fail('Ambiguous recognition must not start'),
		};
		assert.equal(await speech.getOptions(), undefined);
		const first = owner.add(speech.registerSpeechProvider('one', provider));
		const second = owner.add(speech.registerSpeechProvider('two', provider));
		await assert.rejects(speech.createSpeechToTextSession(CancellationToken.None), /Multiple speech providers/);
		await assert.rejects(speech.createTextToSpeechSession(CancellationToken.None), /Multiple speech providers/);
		await assert.rejects(speech.recognizeKeyword(CancellationToken.None), /Multiple speech providers/);
		assert.equal(speech.hasActiveSpeechToTextSession, false);
		first.dispose(); second.dispose();
		assert.deepEqual(changes, [true, true, true, false]);
		await assert.rejects(speech.createTextToSpeechSession(CancellationToken.None), /No speech extension provider/);
	});

	test('provider retirement cancels its text and keyword leases once and permits the replacement', async () => {
		using owner = new DisposableStore(); const speech = owner.add(new SpeechService(undefined));
		const keywordEvents = owner.add(new Emitter<{ status: KeywordRecognitionStatus; }>());
		let cancellations = 0; let syntheses = 0;
		const provider: ISpeechProvider = {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: () => ({ onDidChange: Event.None }),
			createTextToSpeechSession: token => {
				owner.add(token.onCancellationRequested(() => cancellations++));
				return { onDidChange: Event.None, synthesize: async text => { assert.equal(text, 'hello'); syntheses++; } };
			},
			createKeywordRecognitionSession: token => {
				owner.add(token.onCancellationRequested(() => cancellations++));
				return { onDidChange: keywordEvents.event };
			},
		};
		const registration = owner.add(speech.registerSpeechProvider('one', provider));
		let started = 0; let ended = 0; owner.add(speech.onDidStartTextToSpeechSession(() => started++)); owner.add(speech.onDidEndTextToSpeechSession(() => ended++));
		const token = owner.add(new CancellationTokenSource()); const tts = await speech.createTextToSpeechSession(token.token);
		await tts.synthesize('hello'); await tts.synthesize('hello');
		const keyword = speech.recognizeKeyword(CancellationToken.None);
		assert.equal(speech.hasActiveTextToSpeechSession, true); assert.equal(speech.hasActiveKeywordRecognition, true);
		registration.dispose(); assert.equal(await keyword, KeywordRecognitionStatus.Stopped);
		assert.equal(speech.hasActiveTextToSpeechSession, false); assert.equal(speech.hasActiveKeywordRecognition, false);
		assert.equal(cancellations, 2); assert.equal(syntheses, 2); assert.deepEqual([started, ended], [1, 1]);
		owner.add(speech.registerSpeechProvider('replacement', provider));
		const replacement = owner.add(new CancellationTokenSource()); await speech.createTextToSpeechSession(replacement.token);
		token.cancel(); assert.equal(speech.hasActiveTextToSpeechSession, true);
		await assert.rejects(tts.synthesize('hello'), isCancellationError);
		replacement.cancel(); assert.deepEqual([started, ended], [2, 2]);
	});

	test('cancellation inside a provider factory never announces an accepted synthesis session', async () => {
		using owner = new DisposableStore(); const speech = owner.add(new SpeechService(undefined)); const token = owner.add(new CancellationTokenSource());
		let started = 0; owner.add(speech.onDidStartTextToSpeechSession(() => started++));
		owner.add(speech.registerSpeechProvider('one', {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: () => ({ onDidChange: Event.None }),
			createTextToSpeechSession: () => { token.cancel(); return { onDidChange: Event.None, synthesize: async () => { } }; },
			createKeywordRecognitionSession: () => ({ onDidChange: Event.None }),
		}));
		await assert.rejects(speech.createTextToSpeechSession(token.token), isCancellationError);
		assert.equal(started, 0); assert.equal(speech.hasActiveTextToSpeechSession, false);
	});

	test('a provider that completes before acquisition returns still delivers its final phrase once', async () => {
		using owner = new DisposableStore(); const speech = owner.add(new SpeechService(undefined));
		let cancellations = 0;
		const events = owner.add(new Emitter<ISpeechToTextEvent>({
			onDidAddFirstListener: emitter => {
				emitter.fire({ status: SpeechToTextStatus.Started });
				emitter.fire({ status: SpeechToTextStatus.Recognized, text: 'first' });
				emitter.fire({ status: SpeechToTextStatus.Recognized, text: 'second' });
				emitter.fire({ status: SpeechToTextStatus.Stopped });
			}
		}));
		owner.add(speech.registerSpeechProvider('one', {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: token => { owner.add(token.onCancellationRequested(() => cancellations++)); return { onDidChange: events.event }; },
			createTextToSpeechSession: () => assert.fail('Unexpected synthesis'),
			createKeywordRecognitionSession: () => assert.fail('Unexpected keyword recognition'),
		}));
		const session = await speech.createSpeechToTextSession(CancellationToken.None);
		const received: ISpeechToTextEvent[] = []; owner.add(session.onDidChange(event => received.push(event)));
		assert.deepEqual(received, [{ status: SpeechToTextStatus.Started }, { status: SpeechToTextStatus.Recognized, text: 'first' }, { status: SpeechToTextStatus.Recognized, text: 'second' }, { status: SpeechToTextStatus.Stopped }]);
		assert.equal(cancellations, 1); assert.equal(speech.hasActiveSpeechToTextSession, false);
		owner.add(session.onDidChange(event => assert.fail(`Closed receipt replayed ${event.status}`)));
	});

	test('a declared provider activates on first recognition and never opens the fallback capture', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner);
		let captures = 0; const speech = owner.add(new SpeechService({ onDidChangePreparation: Event.None, getPreparation: async () => undefined, prepareModel: async () => { }, cancelPreparation: async () => { }, getOptions: async () => ({ inputDevices: [], languages: [] }), start: async () => { captures++; return { stop: async () => { }, cancel: async () => { } }; } }, extensions));
		assert.equal(speech.hasSpeechProvider, true); assert.equal(await speech.getOptions(), undefined);
		const events = owner.add(new Emitter<ISpeechToTextEvent>()); const activations: string[] = [];
		owner.add(extensions.registerActivationHandler(async (event, signal) => {
			activations.push(event); assert.equal(signal?.aborted, false);
			owner.add(speech.registerSpeechProvider('acme.recognition', {
				metadata: { extension: new ExtensionIdentifier('acme.recognition'), displayName: 'Recognition' },
				createSpeechToTextSession: () => ({ onDidChange: events.event }), createTextToSpeechSession: () => assert.fail('Unexpected synthesis'), createKeywordRecognitionSession: () => assert.fail('Unexpected keyword recognition'),
			}));
		}));
		const session = await speech.createSpeechToTextSession(CancellationToken.None);
		const received: ISpeechToTextEvent[] = []; owner.add(session.onDidChange(value => received.push(value)));
		events.fire({ status: SpeechToTextStatus.Started }); events.fire({ status: SpeechToTextStatus.Recognized, text: 'hello' });
		assert.equal(await speech.stopAndTranscribe(), 'hello');
		assert.deepEqual(activations, ['onSpeech']); assert.equal(captures, 0);
		assert.deepEqual(received, [{ status: SpeechToTextStatus.Started }, { status: SpeechToTextStatus.Recognized, text: 'hello' }, { status: SpeechToTextStatus.Stopped }]);
	});

	test('cancel during provider activation releases only the speech waiter and cannot start late capture', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner); const speech = owner.add(new SpeechService(undefined, extensions));
		let release!: () => void; let signal!: AbortSignal;
		owner.add(extensions.registerActivationHandler((_event, currentSignal) => { signal = currentSignal!; return new Promise(resolve => { release = resolve; }); }));
		const token = owner.add(new CancellationTokenSource()); const starting = speech.createSpeechToTextSession(token.token);
		assert.equal(speech.isStarting, true); token.cancel(); assert.equal(signal.aborted, true); release();
		await assert.rejects(starting, isCancellationError); assert.equal(speech.isStarting, false); assert.equal(speech.hasActiveSpeechToTextSession, false);
	});

	test('a declared provider which fails to register rejects instead of using the builtin microphone', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner); let captures = 0;
		const speech = owner.add(new SpeechService({ onDidChangePreparation: Event.None, getPreparation: async () => undefined, prepareModel: async () => { }, cancelPreparation: async () => { }, getOptions: async () => ({ inputDevices: [], languages: [] }), start: async () => { captures++; return { stop: async () => { }, cancel: async () => { } }; } }, extensions));
		owner.add(extensions.registerActivationHandler(async () => { }));
		await assert.rejects(speech.createSpeechToTextSession(CancellationToken.None), /No speech extension provider/);
		assert.equal(captures, 0); assert.equal(speech.isStarting, false);
	});

	test('language preferences reach each standard provider factory through the existing settings owner', async () => {
		using owner = new DisposableStore(); const configuration = owner.add(new InMemoryConfigurationService()); const speech = owner.add(new SpeechService(undefined, undefined, configuration));
		const languages: (string | undefined)[] = [];
		owner.add(speech.registerSpeechProvider('one', {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: (_token, options) => { languages.push(options?.language); return { onDidChange: Event.None }; },
			createTextToSpeechSession: (_token, options) => { languages.push(options?.language); return { onDidChange: Event.None, synthesize: async () => { } }; },
			createKeywordRecognitionSession: () => ({ onDidChange: Event.None }),
		}));
		await configuration.updateValue(SPEECH_LANGUAGE_CONFIG, 'zh-TW'); await speech.createSpeechToTextSession(CancellationToken.None); await speech.cancel();
		await configuration.updateValue(SPEECH_LANGUAGE_CONFIG, 'tr-TR'); const token = owner.add(new CancellationTokenSource()); await speech.createTextToSpeechSession(token.token); token.cancel();
		assert.deepEqual(languages, ['zh-TW', 'tr-TR']);
		await assert.rejects(configuration.updateValue(SPEECH_LANGUAGE_CONFIG, 'not-a-supported-language'), /supported speech language/);
		assert.equal(configuration.getValue(SPEECH_LANGUAGE_CONFIG), 'tr-TR');
		assert.deepEqual([speechLanguageConfigToLanguage(undefined), speechLanguageConfigToLanguage(3), speechLanguageConfigToLanguage('foo'), speechLanguageConfigToLanguage('auto', 'tr'), speechLanguageConfigToLanguage('auto', 'zh-tw')], ['en-US', 'en-US', 'en-US', 'tr-TR', 'zh-TW']);
	});

	test('keyword cancellation during declared provider activation returns Canceled without acquiring a session', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner); const speech = owner.add(new SpeechService(undefined, extensions));
		const token = owner.add(new CancellationTokenSource()); let release!: () => void;
		owner.add(extensions.registerActivationHandler((_event, signal) => new Promise<void>(resolve => {
			release = resolve;
			owner.add(toDisposable(() => signal?.removeEventListener('abort', release)));
			if (signal?.aborted) resolve();
			else signal?.addEventListener('abort', release, { once: true });
		})));
		const recognized = speech.recognizeKeyword(token.token); token.cancel();
		assert.equal(await recognized, KeywordRecognitionStatus.Canceled); assert.equal(speech.hasActiveKeywordRecognition, false);
	});

	test('window context keys follow the owning service and Cancel dictation is enabled only for active input', async () => {
		using owner = new DisposableStore();
		const contexts = owner.add(new ContextKeyService());
		const speech = owner.add(new SpeechService(undefined, undefined, undefined, contexts));
		const flags = () => ['hasSpeechProvider', 'speechToTextInProgress', 'textToSpeechInProgress'].map(key => contexts.getContext().getValue(key));
		const cancel = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === 'workbench.action.chat.dictation.cancel');
		assert.ok(cancel && 'command' in cancel);
		const canCancel = () => cancel.command.precondition!.evaluate(contexts.getContext());
		assert.deepEqual(flags(), [false, false, false]); assert.equal(canCancel(), false);
		const registration = owner.add(speech.registerSpeechProvider('one', {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: () => ({ onDidChange: Event.None }),
			createTextToSpeechSession: () => ({ onDidChange: Event.None, synthesize: async () => { } }),
			createKeywordRecognitionSession: () => ({ onDidChange: Event.None }),
		}));
		const stt = owner.add(new CancellationTokenSource()); await speech.createSpeechToTextSession(stt.token);
		assert.deepEqual(flags(), [true, true, false]); assert.equal(canCancel(), true);
		stt.cancel(); await speech.cancel(); assert.equal(canCancel(), false);
		const first = owner.add(new CancellationTokenSource()); const second = owner.add(new CancellationTokenSource());
		await speech.createTextToSpeechSession(first.token); await speech.createTextToSpeechSession(second.token);
		first.cancel(); assert.deepEqual(flags(), [true, false, true]);
		second.cancel(); assert.deepEqual(flags(), [true, false, false]);
		registration.dispose(); assert.deepEqual(flags(), [false, false, false]);
		speech.dispose(); assert.deepEqual(flags(), [false, false, false]);
	});

	test('synchronous Cancel from Recording publication prevents microphone acquisition', async () => {
		using owner = new DisposableStore(); let captures = 0;
		const fixture = services(owner, async () => { captures++; return { stop: async () => { }, cancel: async () => { } }; });
		owner.add(fixture.speech.onDidChangeState(state => {
			if (state === SpeechToTextState.Recording) void fixture.speech.cancel();
		}));
		await assert.rejects(fixture.speech.createSpeechToTextSession(CancellationToken.None), isCancellationError);
		assert.equal(captures, 0); assert.equal(fixture.speech.state, SpeechToTextState.Idle);
	});

});

async function declaredExtensions(owner: DisposableStore): Promise<TestExtensionService> {
	const manifestJson = JSON.stringify({ name: 'recognition', publisher: 'acme', version: '1.0.0', contributes: { speechProviders: [{ name: 'acme.recognition', description: 'Recognition' }] } });
	const extensions = owner.add(new TestExtensionService({
		list: async () => ({ generation: 1, diagnostics: [], extensions: [{ id: 'acme.recognition', name: 'recognition', publisher: 'acme', version: '1.0.0', displayName: 'Recognition', sourceKind: 'user', manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`, packageSha256: `sha256:${'b'.repeat(64)}` }] }),
		resources: new ExtensionResourceLoaderService(async () => assert.fail('Speech declaration must not read package resources')),
	}));
	await extensions.start(); return extensions;
}
