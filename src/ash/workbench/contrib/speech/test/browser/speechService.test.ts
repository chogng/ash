import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import '../../../../contrib/accessibility/browser/accessibilityConfiguration.js';
import '../../../chat/browser/actions/chatSpeechToTextActions.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { createHash } from 'node:crypto';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
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
import { SpeechToTextStatus, type ISpeechToTextEvent, type ISpeechToTextSession, type ISpeechProvider, KeywordRecognitionStatus, SPEECH_LANGUAGE_CONFIG, speechLanguageConfigToLanguage } from '../../common/speechService.js';

suite('Workbench speech ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('provider registration controls availability and ambiguity before acquiring any session', async () => {
		using owner = new DisposableStore(); const speech = owner.add(new SpeechService(undefined));
		const changes: boolean[] = []; owner.add(speech.onDidChangeHasSpeechProvider(() => changes.push(speech.hasSpeechProvider)));
		const provider: ISpeechProvider = {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: () => assert.fail('Ambiguous capture must not start'),
			createTextToSpeechSession: () => assert.fail('Ambiguous synthesis must not start'),
			createKeywordRecognitionSession: () => assert.fail('Ambiguous recognition must not start'),
		};
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
		const speech = owner.add(new SpeechService(extensions));
		assert.equal(speech.hasSpeechProvider, true);
		const events = owner.add(new Emitter<ISpeechToTextEvent>()); const activations: string[] = [];
		owner.add(extensions.registerActivationHandler(async (event, signal) => {
			activations.push(event); assert.equal(signal?.aborted, false);
			owner.add(speech.registerSpeechProvider('acme.recognition', {
				metadata: { extension: new ExtensionIdentifier('acme.recognition'), displayName: 'Recognition' },
				createSpeechToTextSession: () => ({ onDidChange: events.event }), createTextToSpeechSession: () => assert.fail('Unexpected synthesis'), createKeywordRecognitionSession: () => assert.fail('Unexpected keyword recognition'),
			}));
		}));
		const source = owner.add(new CancellationTokenSource());
		const session = await speech.createSpeechToTextSession(source.token);
		const received: ISpeechToTextEvent[] = []; owner.add(session.onDidChange(value => received.push(value)));
		events.fire({ status: SpeechToTextStatus.Started }); events.fire({ status: SpeechToTextStatus.Recognized, text: 'hello' });
		await cancelRecognition(owner, session, source);
		assert.deepEqual(activations, ['onSpeech']);
		assert.deepEqual(received, [{ status: SpeechToTextStatus.Started }, { status: SpeechToTextStatus.Recognized, text: 'hello' }, { status: SpeechToTextStatus.Stopped }]);
	});

	test('cancel during provider activation releases only the speech waiter and cannot start late capture', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner); const speech = owner.add(new SpeechService(extensions));
		let release!: () => void; let signal!: AbortSignal;
		owner.add(extensions.registerActivationHandler((_event, currentSignal) => { signal = currentSignal!; return new Promise(resolve => { release = resolve; }); }));
		const token = owner.add(new CancellationTokenSource()); const starting = speech.createSpeechToTextSession(token.token);
		assert.equal(speech.hasActiveSpeechToTextSession, true); token.cancel(); assert.equal(signal.aborted, true); release();
		await assert.rejects(starting, isCancellationError); assert.equal(speech.hasActiveSpeechToTextSession, false);
	});

	test('a declared provider which fails to register rejects instead of using the builtin microphone', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner);
		const speech = owner.add(new SpeechService(extensions));
		owner.add(extensions.registerActivationHandler(async () => { }));
		await assert.rejects(speech.createSpeechToTextSession(CancellationToken.None), /No speech extension provider/);
		assert.equal(speech.hasActiveSpeechToTextSession, false);
	});

	test('language preferences reach each standard provider factory through the existing settings owner', async () => {
		using owner = new DisposableStore(); const configuration = owner.add(new InMemoryConfigurationService()); const speech = owner.add(new SpeechService(undefined, configuration));
		const languages: (string | undefined)[] = [];
		owner.add(speech.registerSpeechProvider('one', {
			metadata: { extension: new ExtensionIdentifier('example'), displayName: 'Recognition' },
			createSpeechToTextSession: (_token, options) => { languages.push(options?.language); return { onDidChange: Event.None }; },
			createTextToSpeechSession: (_token, options) => { languages.push(options?.language); return { onDidChange: Event.None, synthesize: async () => { } }; },
			createKeywordRecognitionSession: () => ({ onDidChange: Event.None }),
		}));
		const recognition = owner.add(new CancellationTokenSource());
		await configuration.updateValue(SPEECH_LANGUAGE_CONFIG, 'zh-TW'); const recognitionSession = await speech.createSpeechToTextSession(recognition.token); await cancelRecognition(owner, recognitionSession, recognition);
		await configuration.updateValue(SPEECH_LANGUAGE_CONFIG, 'tr-TR'); const token = owner.add(new CancellationTokenSource()); await speech.createTextToSpeechSession(token.token); token.cancel();
		assert.deepEqual(languages, ['zh-TW', 'tr-TR']);
		await assert.rejects(configuration.updateValue(SPEECH_LANGUAGE_CONFIG, 'not-a-supported-language'), /supported speech language/);
		assert.equal(configuration.getValue(SPEECH_LANGUAGE_CONFIG), 'tr-TR');
		assert.deepEqual([speechLanguageConfigToLanguage(undefined), speechLanguageConfigToLanguage(3), speechLanguageConfigToLanguage('foo'), speechLanguageConfigToLanguage('auto', 'tr'), speechLanguageConfigToLanguage('auto', 'zh-tw')], ['en-US', 'en-US', 'en-US', 'tr-TR', 'zh-TW']);
	});

	test('keyword cancellation during declared provider activation returns Canceled without acquiring a session', async () => {
		using owner = new DisposableStore(); const extensions = await declaredExtensions(owner); const speech = owner.add(new SpeechService(extensions));
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
		const speech = owner.add(new SpeechService(undefined, undefined, contexts));
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
		const stt = owner.add(new CancellationTokenSource()); const sttSession = await speech.createSpeechToTextSession(stt.token);
		assert.deepEqual(flags(), [true, true, false]); assert.equal(canCancel(), false);
		await cancelRecognition(owner, sttSession, stt); assert.equal(canCancel(), false);
		const first = owner.add(new CancellationTokenSource()); const second = owner.add(new CancellationTokenSource());
		await speech.createTextToSpeechSession(first.token); await speech.createTextToSpeechSession(second.token);
		first.cancel(); assert.deepEqual(flags(), [true, false, true]);
		second.cancel(); assert.deepEqual(flags(), [true, false, false]);
		registration.dispose(); assert.deepEqual(flags(), [false, false, false]);
		speech.dispose(); assert.deepEqual(flags(), [false, false, false]);
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

async function cancelRecognition(owner: DisposableStore, session: ISpeechToTextSession, source: CancellationTokenSource): Promise<void> {
	const stopped = new Promise<void>(resolve => {
		owner.add(session.onDidChange(event => { if (event.status === SpeechToTextStatus.Stopped) resolve(); }));
	});
	source.cancel();
	await stopped;
}
