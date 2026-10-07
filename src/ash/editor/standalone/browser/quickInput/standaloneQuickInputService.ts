import './standaloneQuickInput.css';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { QuickInputController } from '../../../../platform/quickinput/browser/quickInputController.js';
import type { IInputOptions, IQuickInputService, IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

/** Each embedded editor owns the lifetime and geometry of its Quick Input host. */
export class StandaloneQuickInputService extends Disposable implements IQuickInputService {
	private readonly controllers = this._register(new DisposableMap<ICodeEditor, QuickInputController>());

	constructor(
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@ILayoutService private readonly layout: ILayoutService,
	) {
		super();
		this._register(codeEditors.onCodeEditorRemove(editor => {
			this.controllers.deleteAndDispose(editor);
		}));
	}

	public createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		return this.controller().createQuickPick<TItem>();
	}

	public input(options: IInputOptions): Promise<string | undefined> {
		return this.controller().input(options);
	}

	private controller(): QuickInputController {
		this.assertNotDisposed();
		const editor = this.codeEditors.getFocusedCodeEditor() ?? this.codeEditors.getActiveCodeEditor();
		if (!editor) {
			throw new Error('Quick Input requires an active standalone editor');
		}
		let controller = this.controllers.get(editor);
		if (!controller) {
			controller = new QuickInputController(this.layout.activeContainer, 'ash-standalone-quick-input');
			this.controllers.set(editor, controller);
		}
		return controller;
	}
}
