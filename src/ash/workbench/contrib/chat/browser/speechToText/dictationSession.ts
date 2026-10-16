import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { canceled } from '../../../../../base/common/errors.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, type ChatDictationSurface, type IChatSpeechToTextService } from './chatSpeechToTextService.js';

interface EditorRecording {
	readonly service: IChatSpeechToTextService;
	readonly editor: ICodeEditor;
	readonly lifetime: DisposableStore;
	readonly surface: ChatDictationSurface;
	readonly wholeDraft: boolean;
	starting: Promise<void>;
	committed: string;
	cancelled: boolean;
	stopping?: Promise<void>;
}

interface AccuracySample { service: IChatSpeechToTextService; text: string; backend: string; surface: ChatDictationSurface; disposal: IDisposable; }
const samples = new WeakMap<ICodeEditor, AccuracySample>();
const editorChanged = new Emitter<void>();
export const onDidChangeDictationEditor = editorChanged.event;
let recording: EditorRecording | undefined;
let releasing = Promise.resolve();
let generation = 0;
let pending: { editor: ICodeEditor; promise: Promise<void>; } | undefined;
let publishedEditor: ICodeEditor | undefined;

function publishEditor(): void {
	const editor = activeDictationEditor();
	if (editor === publishedEditor) return;
	publishedEditor = editor;
	editorChanged.fire();
}

export function isDictating(): boolean { return !!recording || !!pending; }
export function activeDictationEditor(): ICodeEditor | undefined { return recording?.editor ?? pending?.editor; }
export function isDictationActiveForEditor(editor: ICodeEditor): boolean { return activeDictationEditor() === editor; }

/** A replacement waits for the old inference resource before binding a different editor. */
export function startDictation(service: IChatSpeechToTextService, editor: ICodeEditor, window: Window & typeof globalThis, logService: ILogService, surface: ChatDictationSurface = 'chat'): Promise<void> {
	if (pending?.editor === editor) return pending.promise;
	const promise = bindEditor(service, editor, window, logService, surface);
	const request = { editor, promise };
	pending = request;
	publishEditor();
	const settled = (): void => { if (pending === request) { pending = undefined; publishEditor(); } };
	void promise.then(settled, settled);
	return promise;
}

async function bindEditor(service: IChatSpeechToTextService, editor: ICodeEditor, window: Window & typeof globalThis, logService: ILogService, surface: ChatDictationSurface): Promise<void> {
	if (recording?.editor === editor) return recording.starting;
	const model = editor.getModel();
	cancelDictation();
	const request = ++generation;
	await releasing;
	if (request !== generation) throw canceled();
	if (!model || editor.getModel() !== model) throw canceled();
	if (editor.getOption(EditorOption.readOnly)) return;
	settleSample(editor, false);
	const lifetime = new DisposableStore();
	const current: EditorRecording = { service, editor, lifetime, surface, wholeDraft: editor.getModel()!.getValue().length === 0, starting: Promise.resolve(), committed: '', cancelled: false };
	recording = current;
	const clear = (): void => {
		if (recording !== current) return;
		recording = undefined;
		lifetime.dispose();
		if (!current.cancelled && current.wholeDraft && current.committed) {
			samples.set(editor, { service, text: current.committed, backend: service.currentBackend, surface, disposal: editor.onDidDispose(() => settleSample(editor, false)) });
		}
		publishEditor();
	};
	lifetime.add(service.onDidUpdateTranscript(event => {
		if (recording !== current || current.cancelled || !event.finalizedText.startsWith(current.committed)) return;
		const text = event.finalizedText.slice(current.committed.length);
		current.committed = event.finalizedText;
		const selection = editor.getSelection();
		if (!text || !selection || editor.getOption(EditorOption.readOnly)) return;
		const model = editor.getModel();
		if (!model) return;
		const before = model.getValue().slice(0, model.getOffsetAt(selection.getStartPosition()));
		const separator = /[A-Za-z0-9]$/u.test(before) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		editor.pushUndoStop();
		editor.executeEdits('dictation', [{ range: selection, text: separator + text }], inverse => inverse.map(edit => Selection.fromPositions(edit.range.getEndPosition())));
		editor.pushUndoStop();
		editor.focus();
	}));
	lifetime.add(editor.onWillChangeModel(() => cancelDictation()));
	lifetime.add(editor.onDidDispose(() => cancelDictation()));
	lifetime.add(service.onDidChangeState(() => { if (!service.isBusy) clear(); }));
	const timeout = window.setTimeout(() => { if (recording === current) void stopDictation().catch(error => logService.error(error)); }, 20 * 60 * 1000);
	lifetime.add(toDisposable(() => window.clearTimeout(timeout)));
	current.starting = service.start(window, surface);
	publishEditor();
	try {
		await current.starting;
		if (current.cancelled) throw canceled();
		if (!service.isBusy || service.state === ChatSpeechToTextState.Idle) clear();
	} catch (error) { clear(); throw error; }
}

export async function stopDictation(): Promise<void> {
	const current = recording;
	if (!current && pending) { await pending.promise; return stopDictation(); }
	if (!current) return releasing;
	current.stopping ??= (async () => {
		await current.starting;
		if (!current.cancelled) await current.service.stopAndTranscribe();
	})();
	return current.stopping;
}

export async function stopDictationForEditor(editor: ICodeEditor): Promise<void> {
	if (pending?.editor === editor) await pending.promise;
	if (recording?.editor === editor) await stopDictation();
	else await releasing;
}

/** Retire listeners before cancelling so a late result cannot edit a replacement model. */
export function cancelDictation(): void {
	generation++;
	pending = undefined;
	const current = recording;
	if (!current) { publishEditor(); return; }
	current.cancelled = true;
	recording = undefined;
	current.lifetime.dispose();
	releasing = Promise.allSettled([current.starting, current.service.cancel()]).then(() => undefined);
	publishEditor();
}

export function notifyDictationSubmitted(editor: ICodeEditor): void { settleSample(editor, true); }

function settleSample(editor: ICodeEditor, submitted: boolean): void {
	const sample = samples.get(editor);
	if (!sample) return;
	samples.delete(editor);
	sample.disposal.dispose();
	sample.service.logDictationAccuracy({ dictatedText: sample.text, submittedText: editor.getModel()?.getValue() ?? '', backend: sample.backend, surface: sample.surface, submitted });
}
