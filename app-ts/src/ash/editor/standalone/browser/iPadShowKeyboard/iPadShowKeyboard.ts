import './iPadShowKeyboard.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { isIOS } from '../../../../base/browser/browser.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { type ICodeEditor, type IOverlayWidget, type IOverlayWidgetPosition, OverlayWidgetPositionPreference } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import type { IEditorContribution } from '../../../common/editorCommon.js';

export class IPadShowKeyboard extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.iPadShowKeyboard';
	private widget: ShowKeyboardWidget | undefined;

	constructor(private readonly editor: ICodeEditor) {
		super();
		if (isIOS) {
			this._register(editor.onDidChangeConfiguration(() => this.update()));
			this.update();
		}
	}

	private update(): void {
		if (this.editor.getOption(EditorOption.readOnly)) {
			this.widget?.dispose();
			this.widget = undefined;
		} else if (!this.widget) {
			this.widget = new ShowKeyboardWidget(this.editor);
		}
	}

	public override dispose(): void {
		this.widget?.dispose();
		this.widget = undefined;
		super.dispose();
	}
}

class ShowKeyboardWidget extends Disposable implements IOverlayWidget {
	private static readonly ID = 'editor.contrib.ShowKeyboardWidget';
	private readonly domNode: HTMLDivElement;

	constructor(private readonly editor: ICodeEditor) {
		super();
		const document = editor.getContainerDomNode().ownerDocument;
		this.domNode = document.createElement('div');
		this.domNode.className = 'stanza-editor-show-keyboard';
		const input = document.createElement('textarea');
		input.setAttribute('role', 'button');
		input.setAttribute('aria-label', localize('iPadShowKeyboard.label', 'Show Keyboard'));
		input.spellcheck = false;
		this.domNode.append(input);
		this._register(addDisposableListener(input, 'touchstart', () => this.editor.focus()));
		this._register(addDisposableListener(input, 'focus', () => this.editor.focus()));
		editor.addOverlayWidget(this);
	}

	public getId(): string {
		return ShowKeyboardWidget.ID;
	}

	public getDomNode(): HTMLElement {
		return this.domNode;
	}

	public getPosition(): IOverlayWidgetPosition {
		return { preference: OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER };
	}

	public override dispose(): void {
		this.editor.removeOverlayWidget(this);
		super.dispose();
	}
}

registerEditorContribution(IPadShowKeyboard.ID, IPadShowKeyboard, EditorContributionInstantiation.Eventually);
