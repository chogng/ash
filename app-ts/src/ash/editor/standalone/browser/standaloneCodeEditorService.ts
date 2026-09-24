import { AbstractCodeEditorService } from '../../browser/services/abstractCodeEditorService.js';
import { DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../browser/editorBrowser.js';

export class StandaloneCodeEditorService extends AbstractCodeEditorService {
	private readonly recentEditors: ICodeEditor[] = [];
	private readonly focusListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	constructor() {
		super();
		this._register(toDisposable(() => { this.recentEditors.length = 0; }));
		this._register(this.onCodeEditorAdd(editor => {
			if (!this.recentEditors.includes(editor)) {
				this.recentEditors.unshift(editor);
			}
			const listeners = new DisposableStore();
			this.focusListeners.set(editor, listeners);
			listeners.add(editor.onDidFocusEditorText(() => this.markActive(editor)));
			listeners.add(editor.onDidFocusEditorWidget(() => this.markActive(editor)));
			if (editor.hasWidgetFocus()) {
				this.markActive(editor);
			}
		}));
		this._register(this.onCodeEditorRemove(editor => {
			this.focusListeners.deleteAndDispose(editor);
			const index = this.recentEditors.indexOf(editor);
			if (index >= 0) {
				this.recentEditors.splice(index, 1);
			}
		}));
	}

	public getActiveCodeEditor(): ICodeEditor | null {
		return this.getFocusedCodeEditor() ?? this.recentEditors.at(-1) ?? null;
	}

	private markActive(editor: ICodeEditor): void {
		const index = this.recentEditors.indexOf(editor);
		if (index >= 0) {
			this.recentEditors.splice(index, 1);
		}
		this.recentEditors.push(editor);
	}
}
