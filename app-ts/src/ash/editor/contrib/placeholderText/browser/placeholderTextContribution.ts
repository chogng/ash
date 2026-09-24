import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableCodeEditor } from '../../../browser/observableCodeEditor.js';
import { type ICodeEditor, type IOverlayWidget, type IOverlayWidgetPosition } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';

/** Uses the editor option to present placeholder text while the model is empty. */
export class PlaceholderTextContribution extends Disposable implements IEditorContribution {
	public static get(editor: ICodeEditor): PlaceholderTextContribution {
		return editor.getContribution<PlaceholderTextContribution>(PlaceholderTextContribution.ID)!;
	}

	public static readonly ID = 'editor.contrib.placeholderText';
	private readonly element: HTMLDivElement;
	private readonly widget: IOverlayWidget;
	private position: IOverlayWidgetPosition | null = null;
	private isEmpty: boolean;

	constructor(private readonly editor: ICodeEditor) {
		super();
		const editorObservable = observableCodeEditor(editor);
		const element = h(editor.getDomNode()!.ownerDocument, 'div', {
			className: ['stanza-editor-placeholder-text', 'stanza-editor-overlay-widget'],
			attributes: { 'aria-hidden': 'true' },
		});
		this.element = element;
		this.isEmpty = editorObservable.valueIsEmpty.get();
		this.widget = {
			getId: () => PlaceholderTextContribution.ID,
			getDomNode: () => this.element,
			getPosition: () => this.position,
		};
		this.update();
		editor.addOverlayWidget(this.widget);
		this._register(toDisposable(() => editor.removeOverlayWidget(this.widget)));
		this._register(editorObservable.valueIsEmpty.onDidChange(empty => {
			this.isEmpty = empty;
			this.update();
		}));
		this._register(editor.onDidChangeConfiguration(() => this.update()));
		this._register(editor.onDidLayoutChange(() => this.updateLayout()));
	}

	private update(): void {
		const placeholder = this.editor.getOption(EditorOption.placeholder);
		this.element.textContent = placeholder ?? '';
		this.position = placeholder && this.isEmpty ? { preference: { left: 0, top: 0 } } : null;
		this.updateLayout();
	}

	private updateLayout(): void {
		const layout = this.editor.getLayoutInfo();
		const top = this.editor.getTopForLineNumber(1);
		this.position = this.position ? { preference: { left: layout.contentLeft, top } } : null;
		this.element.style.width = `${Math.max(0, layout.contentWidth - layout.verticalScrollbarWidth)}px`;
		this.element.style.fontFamily = this.editor.getOption(EditorOption.fontFamily);
		this.element.style.fontSize = `${this.editor.getOption(EditorOption.fontSize)}px`;
		this.element.style.lineHeight = `${this.editor.getOption(EditorOption.lineHeight)}px`;
		this.editor.layoutOverlayWidget(this.widget);
	}
}
