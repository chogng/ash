import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IDebugService } from '../../../services/debug/common/debugService.js';

/** Observes the editor and marker owners without retaining document or diagnostic state. */
export class EditorTextPropertySignalsContribution extends Disposable {
	private readonly editors = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	constructor(
		@ICodeEditorService codeEditors: ICodeEditorService,
		@IMarkerService markers: IMarkerService,
		@IDebugService debug: IDebugService,
		@IAccessibilitySignalService signals: IAccessibilitySignalService,
	) {
		super();
		const attach = (editor: ICodeEditor): void => {
			if (this.editors.has(editor)) { return; }
			const lifetime = new DisposableStore();
			this.editors.set(editor, lifetime);
			let previous = new Map<AccessibilitySignal, string>();
			const timer = lifetime.add(new RunOnceScheduler(() => {
				if (codeEditors.getFocusedCodeEditor() !== editor) { return; }
				const model = editor.getModel();
				const position = editor.getPosition();
				if (!model || !position) { return; }
				const line = position.lineNumber - 1;
				const column = position.column - 1;
				const onLine = markers.read(model.uri).filter(marker => marker.range.start.lineIndex <= line && marker.range.end.lineIndex >= line
					&& (marker.range.end.lineIndex > line || marker.range.end.columnIndex > 0 || marker.range.start.lineIndex === line));
				const next = new Map<AccessibilitySignal, string>();
				for (const severity of [MarkerSeverity.Error, MarkerSeverity.Warning]) {
					const matched = onLine.filter(marker => marker.severity === severity);
					if (!matched.length) { continue; }
					const atPosition = matched.filter(marker => (marker.range.start.lineIndex < line || marker.range.start.columnIndex <= column)
						&& (marker.range.end.lineIndex > line || column < marker.range.end.columnIndex
							|| (marker.range.start.lineIndex === line && marker.range.start.columnIndex === column && marker.range.end.columnIndex === column)));
					let signal = atPosition.length ? AccessibilitySignal.errorAtPosition : AccessibilitySignal.errorOnLine;
					if (severity === MarkerSeverity.Warning) {
						signal = atPosition.length ? AccessibilitySignal.warningAtPosition : AccessibilitySignal.warningOnLine;
					}
					const signature = JSON.stringify([model.uri.toString(), line, (atPosition.length ? atPosition : matched).map(marker => [marker.owner, marker.id])]);
					next.set(signal, signature);
				}
				if (debug.breakpoints.some(point => 'resource' in point && point.enabled && point.lineNumber === position.lineNumber && point.resource.toString() === model.uri.toString())) {
					next.set(AccessibilitySignal.break, `${model.uri}:${line}`);
				}
				for (const [signal, signature] of next) {
					if (previous.get(signal) !== signature) { void signals.playSignal(signal); }
				}
				previous = next;
			}, 250));
			lifetime.add(editor.onDidChangeCursorPosition(() => timer.schedule()));
			lifetime.add(editor.onDidFocusEditorText(() => timer.schedule()));
			lifetime.add(editor.onDidBlurEditorText(() => { timer.cancel(); previous.clear(); }));
			lifetime.add(editor.onDidChangeModel(() => { previous.clear(); timer.schedule(); }));
			lifetime.add(markers.onDidChange(() => timer.schedule()));
			lifetime.add(debug.onDidChangeBreakpoints(() => timer.schedule()));
		};
		this._register(codeEditors.onCodeEditorAdd(attach));
		this._register(codeEditors.onCodeEditorRemove(editor => this.editors.deleteAndDispose(editor)));
		for (const editor of codeEditors.listCodeEditors()) { attach(editor); }
	}
}
