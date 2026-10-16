import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../../../../editor/test/browser/editorTestGlobals.js';
import { createTestCodeEditor } from '../../../../../../editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { Selection } from '../../../../../../editor/common/core/selection.js';
import { NullLoggerService } from '../../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, type IChatSpeechToTextService, type IChatDictationTranscript, type IDictationAccuracyMeasurement, type ChatDictationSurface } from '../../../browser/speechToText/chatSpeechToTextService.js';
import { activeDictationEditor, cancelDictation, isDictating, notifyDictationSubmitted, onDidChangeDictationEditor, startDictation, stopDictation, stopDictationForEditor } from '../../../browser/speechToText/dictationSession.js';

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
	isBusy = false;
	starts = 0;
	stops = 0;
	cancels = 0;
	startBarrier?: DeferredPromise<void>;
	stopBarrier?: DeferredPromise<void>;
	cancelBarrier?: DeferredPromise<void>;
	finalText = '';
	readonly measurements: IDictationAccuracyMeasurement[] = [];
	async switchMicrophone() { return undefined; }
	async start(_window: Window & typeof globalThis, surface: ChatDictationSurface = 'chat') {
		this.starts++; this.currentSurface = surface; this.isBusy = true; this.state = ChatSpeechToTextState.Recording;
		this.states.fire(this.state); await this.startBarrier?.p;
	}
	async stopAndTranscribe() {
		this.stops++; await this.stopBarrier?.p;
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
