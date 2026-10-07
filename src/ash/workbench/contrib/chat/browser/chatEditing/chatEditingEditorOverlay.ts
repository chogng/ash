import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatEditingCodeEditorIntegration } from './chatEditingCodeEditorIntegration.js';

export class ChatEditingEditorOverlay extends Disposable {
	public static readonly ID = 'chat.edits.editorOverlay';
	private readonly editors = this._register(new DisposableMap<ICodeEditor, ChatEditingCodeEditorIntegration>());

	constructor(@ICodeEditorService codeEditors: ICodeEditorService, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this._register(codeEditors.onCodeEditorAdd(editor => this.attach(editor)));
		this._register(codeEditors.onCodeEditorRemove(editor => this.editors.deleteAndDispose(editor)));
		for (const editor of codeEditors.listCodeEditors()) { this.attach(editor); }
	}

	private attach(editor: ICodeEditor): void { this.editors.set(editor, this.instantiation.createInstance(ChatEditingCodeEditorIntegration, editor)); }
}
