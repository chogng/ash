import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test, teardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../../../../editor/test/browser/editorTestGlobals.js';
import { createTestCodeEditor } from '../../../../../../editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { Selection } from '../../../../../../editor/common/core/selection.js';
import { NullLoggerService } from '../../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, IChatSpeechToTextService, type IChatDictationTranscript, type IDictationAccuracyMeasurement, type ChatDictationSurface } from '../../../browser/speechToText/chatSpeechToTextService.js';
import { activeDictationEditor, cancelDictation, isDictating, notifyDictationSubmitted, onDidChangeDictationEditor, startDictation, stopDictation, stopDictationForEditor } from '../../../browser/speechToText/dictationSession.js';
import '../../../browser/actions/chatSpeechToTextActions.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILocalTranscriptionModelService } from '../../../../../../platform/localTranscription/common/localTranscription.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IPreferencesService } from '../../../../../services/preferences/common/preferences.js';
import { ISpeechService } from '../../../../speech/common/speechService.js';
import { IDictationOnboardingService } from '../../../browser/speechToText/dictationOnboarding.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import { ChatWidgetService } from '../../../browser/widget/chatWidgetService.js';

class Recognition extends Disposable implements IChatSpeechToTextService {
	readonly _serviceBrand = undefined;
	readonly states = this._register(new Emitter<ChatSpeechToTextState>());
	readonly transcripts = this._register(new Emitter<IChatDictationTranscript>());
	readonly onDidChangeState = this.states.event;
	readonly onDidUpdateTranscript = this.transcripts.event;
	readonly onDidChangePreparingModel = Event.None;
	readonly onDidChangeDownloadingModel = Event.None;
	readonly onDidChangeModelDownloadProgress = Event.None;
	readonly isConfigured = true;
	readonly showTranscriptWhileDictating = true;
	readonly isPreparingModel = false;
	readonly isDownloadingModel = false;
	readonly modelDownloadProgress = undefined;
	readonly analyserNode = undefined;
	readonly currentBackend = 'test';
	currentSurface: ChatDictationSurface = 'chat';
	state = ChatSpeechToTextState.Idle;
	startState = ChatSpeechToTextState.Recording;
	isBusy = false;
	starts = 0;
	stops = 0;
	cancels = 0;
	startBarrier?: DeferredPromise<void>;
	stopBarrier?: DeferredPromise<void>;
	idleBeforeStop = false;
	cancelBarrier?: DeferredPromise<void>;
	finalText = '';
	readonly measurements: IDictationAccuracyMeasurement[] = [];
	async switchMicrophone() { return undefined; }
	async start(_window: Window & typeof globalThis, surface: ChatDictationSurface = 'chat') {
		this.starts++; this.currentSurface = surface; this.isBusy = true; this.state = this.startState;
		this.states.fire(this.state); await this.startBarrier?.p;
	}
	async stopAndTranscribe() {
		this.stops++;
		if (this.idleBeforeStop) this.idle();
		await this.stopBarrier?.p;
		this.transcripts.fire({ text: this.finalText, finalizedText: this.finalText });
		this.idle(); return this.finalText;
	}
	async cancel() { this.cancels++; await this.cancelBarrier?.p; this.idle(); }
	idle() { this.isBusy = false; this.state = ChatSpeechToTextState.Idle; this.states.fire(this.state); }
	logDictationAccuracy(value: IDictationAccuracyMeasurement) { this.measurements.push(value); }
}

function fixture() {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>', { pretendToBeVisual: true });
	lifetime.add(toDisposable(() => dom.window.close()));
	lifetime.add(installEditorTestDom(dom, ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'NodeFilter']));
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const model = lifetime.add(new TextModel(''));
	const otherModel = lifetime.add(new TextModel(''));
	const editor = lifetime.add(createTestCodeEditor({ container: dom.window.document.querySelector('main')!, model, contributions: [] }));
	const other = lifetime.add(createTestCodeEditor({ container: dom.window.document.querySelector('aside')!, model: otherModel, contributions: [] }));
	const speech = lifetime.add(new Recognition());
	const log = lifetime.add(new NullLoggerService());
	const window = dom.window as unknown as Window & typeof globalThis;
	return { editor, other, model, otherModel, speech, log, window, dispose: () => lifetime.dispose(), [Symbol.dispose]: () => lifetime.dispose() };
}

suite('Dictation editor binding', () => {
	teardown(async () => { cancelDictation(); await stopDictation(); });
	test('acquired speech remains bound while waiting for the provider Started event', async () => {
		using f = fixture();
		f.speech.startState = ChatSpeechToTextState.Idle;
		await startDictation(f.speech, f.editor, f.window, f.log);
		assert.equal(activeDictationEditor(), f.editor);
		f.speech.state = ChatSpeechToTextState.Recording;
		f.speech.states.fire(f.speech.state);
		f.speech.transcripts.fire({ text: 'delayed start', finalizedText: 'delayed start' });
		assert.equal(f.model.getValue(), 'delayed start');
		await stopDictation();
		assert.equal(isDictating(), false);
	});
	test('repeated starts share acquisition; stop before binding waits for the final edit', async () => {
		using f = fixture();
		f.speech.startBarrier = new DeferredPromise<void>();
		f.speech.finalText = 'final draft';
		const first = startDictation(f.speech, f.editor, f.window, f.log);
		assert.equal(startDictation(f.speech, f.editor, f.window, f.log), first);
		const stopping = stopDictationForEditor(f.editor);
		await f.speech.startBarrier.complete();
		await Promise.all([first, stopping]);
		assert.equal(f.speech.starts, 1);
		assert.equal(f.speech.stops, 1);
		assert.equal(f.model.getValue(), 'final draft');
		assert.equal(isDictating(), false);
	});
	test('cancelled editor startup cannot block a replacement after the speech owner has released it', async () => {
		using f = fixture();
		const gate = new DeferredPromise<void>();
		f.speech.startBarrier = gate;
		const first = startDictation(f.speech, f.editor, f.window, f.log);
		const rejected = assert.rejects(first, isCancellationError);
		await Promise.resolve();
		cancelDictation();
		f.speech.startBarrier = undefined;
		await startDictation(f.speech, f.other, f.window, f.log);
		await gate.complete();
		await rejected;
		assert.equal(activeDictationEditor(), f.other);
		f.speech.transcripts.fire({ text: 'replacement only', finalizedText: 'replacement only' });
		assert.equal(f.model.getValue(), '');
		assert.equal(f.otherModel.getValue(), 'replacement only');
	});
	test('repeated editor stops wait for finalization even after capture becomes idle', async () => {
		using f = fixture();
		f.speech.stopBarrier = new DeferredPromise<void>();
		f.speech.idleBeforeStop = true;
		f.speech.finalText = 'complete draft';
		await startDictation(f.speech, f.editor, f.window, f.log);
		await stopDictationForEditor(f.other);
		assert.equal(f.speech.stops, 0);
		const first = stopDictationForEditor(f.editor);
		await Promise.resolve();
		let secondFinished = false;
		const second = stopDictationForEditor(f.editor).then(() => { secondFinished = true; });
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.equal(secondFinished, false);
			assert.equal(activeDictationEditor(), f.editor);
			assert.equal(f.model.getValue(), '');
		} finally {
			await f.speech.stopBarrier.complete();
			await Promise.all([first, second]);
		}
		assert.equal(f.speech.stops, 1);
		assert.equal(f.model.getValue(), 'complete draft');
		assert.ok(activeDictationEditor() === undefined);
	});
	test('failed finalization releases the editor and permits a new dictation', async () => {
		using f = fixture();
		f.speech.stopBarrier = new DeferredPromise<void>();
		await startDictation(f.speech, f.editor, f.window, f.log);
		const failed = assert.rejects(stopDictationForEditor(f.editor), /transcription failed/u);
		await f.speech.stopBarrier.error(new Error('transcription failed'));
		await failed;
		assert.ok(activeDictationEditor() === undefined);
		f.speech.stopBarrier = undefined;
		await startDictation(f.speech, f.other, f.window, f.log);
		f.speech.finalText = 'new recording';
		await stopDictationForEditor(f.other);
		assert.equal(f.model.getValue(), '');
		assert.equal(f.otherModel.getValue(), 'new recording');
	});
	test('replacement waits for cancellation and late results cannot edit the retired editor', async () => {
		using f = fixture();
		const owners: unknown[] = [];
		using listener = onDidChangeDictationEditor(() => owners.push(activeDictationEditor()));
		await startDictation(f.speech, f.editor, f.window, f.log);
		f.speech.cancelBarrier = new DeferredPromise<void>();
		const next = startDictation(f.speech, f.other, f.window, f.log, 'editor');
		assert.equal(activeDictationEditor(), f.other);
		f.speech.transcripts.fire({ text: 'late', finalizedText: 'late' });
		assert.equal(f.model.getValue(), '');
		assert.equal(f.speech.starts, 1);
		await f.speech.cancelBarrier.complete(); await next;
		f.speech.transcripts.fire({ text: 'new draft', finalizedText: 'new draft' });
		assert.equal(f.otherModel.getValue(), 'new draft');
		assert.equal(f.speech.currentSurface, 'editor');
		assert.deepEqual(owners, [f.editor, undefined, f.other]);
	});
	test('finalized prefixes insert once at the current selection and deletion stays deleted', async () => {
		using f = fixture();
		f.model.setValue('left right'); f.editor.setSelection(new Selection(1, 6, 1, 11));
		await startDictation(f.speech, f.editor, f.window, f.log);
		f.speech.transcripts.fire({ text: 'first interim', finalizedText: 'first' });
		assert.equal(f.model.getValue(), 'left first');
		await f.model.undo();
		assert.equal(f.model.getValue(), 'left right');
		f.speech.transcripts.fire({ text: 'first next tail', finalizedText: 'first next' });
		assert.equal(f.model.getValue().includes('first'), false);
		assert.equal(f.model.getValue().includes('next'), true);
	});
	test('model replacement cancels the capture and submission settles accuracy once', async () => {
		using f = fixture();
		f.speech.finalText = 'draft';
		await startDictation(f.speech, f.editor, f.window, f.log);
		await stopDictation();
		notifyDictationSubmitted(f.editor); notifyDictationSubmitted(f.editor);
		assert.deepEqual(f.speech.measurements, [{ dictatedText: 'draft', submittedText: 'draft', backend: 'test', surface: 'chat', submitted: true }]);
		await startDictation(f.speech, f.editor, f.window, f.log);
		f.editor.setModel(f.otherModel);
		await stopDictation();
		assert.equal(isDictating(), false);
		assert.equal(f.speech.cancels, 1);
	});
});

function commandFixture() {
	const resources = new DisposableStore();
	const f = resources.add(fixture());
	const services = resources.add(new InstantiationService());
	const widgets = resources.add(new ChatWidgetService());
	const hidden = resources.add(new Emitter<void>());
	const changed = resources.add(new Emitter<void>());
	const released = new DeferredPromise<void>();
	const widget: IChatWidget & { visible: boolean; isTranscriptProgressActive: boolean; } = {
		domNode: f.editor.getContainerDomNode(), inputEditor: f.editor, visible: true,
		isTranscriptProgressActive: false, onDidHide: hidden.event, onDidChangeViewModel: changed.event,
		startVoiceConversation: async () => { throw new Error('Unexpected voice mode'); },
	};
	const registration = resources.add(widgets.register(widget));
	f.editor.focus();
	services.registerInstance(IChatWidgetService, widgets);
	services.registerInstance(IChatSpeechToTextService, f.speech);
	services.registerInstance(ILogService, f.log);
	services.registerInstance(IConfigurationService, {} as IConfigurationService);
	services.registerInstance(ILocalTranscriptionModelService, {} as ILocalTranscriptionModelService);
	services.registerInstance(ISpeechService, { hasSpeechProvider: true } as ISpeechService);
	services.registerInstance(IPreferencesService, { openSettings: async () => { throw new Error('Unexpected settings'); } } as unknown as IPreferencesService);
	services.registerInstance(IDictationOnboardingService, { showIfNeeded: () => false } as IDictationOnboardingService);
	services.registerInstance(IKeybindingService, { enableKeybindingHoldMode: () => released.p } as unknown as IKeybindingService);
	const run = (id = 'toggleSpeechToText', context?: unknown) => services.invokeFunction(accessor => CommandsRegistry.getCommand(`workbench.action.chat.${id}`)!(accessor, context));
	return { ...f, services, widgets, widget, hidden, changed, released, registration, run, [Symbol.dispose]: () => resources.dispose() };
}

suite('Chat dictation command targeting', () => {
	teardown(async () => { cancelDictation(); await stopDictation(); mock.timers.reset(); });

	test('the window registry retains Chat focus when an unrelated code editor takes focus', async () => {
		using f = commandFixture();
		f.other.focus();
		await f.run();
		f.speech.transcripts.fire({ text: 'chat only', finalizedText: 'chat only' });
		assert.equal(f.model.getValue(), 'chat only');
		assert.equal(f.otherModel.getValue(), '');
		await f.run();
		assert.equal(f.speech.stops, 1);
	});

	test('hidden, blocked, unregistered and foreign context targets do not acquire speech', async () => {
		using f = commandFixture();
		f.widget.visible = false;
		await f.run();
		f.widget.visible = true;
		f.widget.isTranscriptProgressActive = true;
		await f.run('holdToSpeechToText');
		f.widget.isTranscriptProgressActive = false;
		await f.run('toggleSpeechToText', { widget: { ...f.widget } });
		f.registration.dispose();
		await f.run('toggleSpeechToText', { widget: f.widget });
		assert.equal(f.speech.starts, 0);
		assert.equal(f.widgets.lastFocusedWidget, undefined);
		assert.deepEqual(f.widgets.getAllWidgets(), []);
	});

	for (const retirement of ['hide', 'navigate'] as const) {
		test(`${retirement} retires command capture before a late transcript can change the input`, async () => {
			using f = commandFixture();
			await f.run();
			if (retirement === 'hide') { f.widget.visible = false; f.hidden.fire(); }
			else f.changed.fire();
			f.speech.transcripts.fire({ text: 'stale', finalizedText: 'stale' });
			await stopDictation();
			assert.equal(f.model.getValue(), '');
			assert.equal(f.speech.cancels, 1);
		});
	}

	test('a tap released during preparation never starts the provider', async () => {
		using f = commandFixture();
		const run = f.run('holdToSpeechToText');
		await f.released.complete();
		await run;
		assert.equal(f.speech.starts, 0);
		assert.equal(isDictating(), false);
	});

	for (const cancellation of ['cancelSpeechToText', 'toggleSpeechToText'] as const) {
		test(`${cancellation} cancels delayed local ASR preparation before it can start capture`, async () => {
			using f = commandFixture();
			const model = new DeferredPromise<Awaited<ReturnType<ILocalTranscriptionModelService['getModel']>>>();
			Object.assign(f.services.get(ISpeechService), { hasSpeechProvider: false });
			Object.assign(f.services.get(IConfigurationService), { getValue: () => undefined });
			Object.assign(f.services.get(ILocalTranscriptionModelService), { isSupported: true, getModel: () => model.p });
			const pending = f.run();
			await f.run(cancellation);
			await model.complete({ available: true } as Awaited<ReturnType<ILocalTranscriptionModelService['getModel']>>);
			await pending;
			assert.equal(f.speech.starts, 0);
			assert.equal(isDictating(), false);
		});
	}

	test('a short hold cancels acquisition and discards its late transcript', async () => {
		using f = commandFixture();
		f.speech.startBarrier = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		using listener = f.speech.onDidChangeState(() => { void started.complete(); });
		const run = f.run('holdToSpeechToText');
		await started.p;
		await f.released.complete();
		f.speech.transcripts.fire({ text: 'discard', finalizedText: 'discard' });
		await f.speech.startBarrier.complete();
		await run;
		assert.equal(f.speech.cancels, 1);
		assert.equal(f.speech.stops, 0);
		assert.equal(f.model.getValue(), '');
	});

	test('a long hold stops its capture once and inserts the final result', async () => {
		using f = commandFixture();
		mock.timers.enable({ apis: ['Date'], now: 1000 });
		f.speech.finalText = 'held message';
		const started = new DeferredPromise<void>();
		using listener = f.speech.onDidChangeState(() => { void started.complete(); });
		const run = f.run('holdToSpeechToText');
		await started.p;
		mock.timers.tick(600);
		await f.released.complete();
		await run;
		assert.equal(f.model.getValue(), 'held message');
		assert.equal(f.speech.stops, 1);
	});

	test('a retired hold cannot stop a replacement recording in the same editor', async () => {
		using f = commandFixture();
		mock.timers.enable({ apis: ['Date'], now: 1000 });
		const started = new DeferredPromise<void>();
		using listener = f.speech.onDidChangeState(() => { void started.complete(); });
		const run = f.run('holdToSpeechToText');
		await started.p;
		cancelDictation();
		await startDictation(f.speech, f.editor, f.window, f.log);
		mock.timers.tick(600);
		await f.released.complete();
		await run;
		assert.equal(f.speech.stops, 0);
		assert.equal(activeDictationEditor(), f.editor);
	});

	test('a palette invocation of hold does not leave an unbounded recording', async () => {
		using f = commandFixture();
		Object.assign(f.services.get(IKeybindingService), { enableKeybindingHoldMode: () => undefined });
		await f.run('holdToSpeechToText');
		assert.equal(f.speech.starts, 0);
	});
});
