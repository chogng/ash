import './standaloneQuickInput.css';
import { DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { QuickInputService } from '../../../../platform/quickinput/browser/quickInputService.js';
import { QuickInputController } from '../../../../platform/quickinput/browser/quickInputController.js';
import type { IQuickInput } from '../../../../platform/quickinput/common/quickInput.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

/** Each embedded editor owns the lifetime and geometry of its Quick Input host. */
export class StandaloneQuickInputService extends QuickInputService {
	private readonly controllers = this._register(new DisposableMap<ICodeEditor, IDisposable & { readonly controller: QuickInputController }>());

	constructor(
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@ILayoutService layout: ILayoutService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(instantiation, contextKeys, layout);
		this._register(
			codeEditors.onCodeEditorRemove(editor => {
				this.controllers.deleteAndDispose(editor);
			}),
		);
		this._register(
			layout.onDidChangeActiveContainer(() => {
				for (const [editor, entry] of this.controllers) {
					if (editor.getContainerDomNode() !== layout.activeContainer) entry.controller.currentQuickInput?.hide();
				}
			}),
		);
	}

	public override get currentQuickInput(): IQuickInput | undefined {
		const editor = this.codeEditors.getFocusedCodeEditor() ?? this.codeEditors.getActiveCodeEditor();
		return editor ? this.controllers.get(editor)?.controller.currentQuickInput : undefined;
	}

	protected override get controller(): QuickInputController {
		this.assertNotDisposed();
		const editor = this.codeEditors.getFocusedCodeEditor() ?? this.codeEditors.getActiveCodeEditor();
		if (!editor) {
			throw new Error('Quick Input requires an active standalone editor');
		}
		for (const [owner, entry] of this.controllers) {
			if (owner !== editor) entry.controller.currentQuickInput?.hide();
		}
		let entry = this.controllers.get(editor);
		if (!entry) {
			const controller = this.createController('ash-standalone-quick-input', editor.getContainerDomNode());
			const lifetime = new DisposableStore();
			lifetime.add(controller);
			const layout = (): void => controller.layout(editor.getLayoutInfo(), 0);
			lifetime.add(editor.onDidLayoutChange(layout));
			layout();
			entry = Object.assign(
				toDisposable(() => lifetime.dispose()),
				{ controller },
			);
			this.controllers.set(editor, entry);
		}
		return entry.controller;
	}
}
