import { h } from '../../../../base/browser/dom.js';
import { DEFAULT_FONT_FAMILY } from '../../../../base/browser/fonts.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { PlaceholderTextContribution } from '../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import '../../../../editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ISCMInput } from '../common/scm.js';
import './media/scm.css';

/** Owns the editing surface; the SCM provider retains the repository's commit draft. */
export class SCMInputWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly model = this._register(new TextModel('', { languageId: 'plaintext' }));
	private readonly editor: CodeEditorWidget;
	private readonly editorDomNode: HTMLDivElement;
	private boundInput: ISCMInput | undefined;
	private height = 24;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-scm-input';
		this.editorDomNode = h(container.ownerDocument, 'div');
		this.editorDomNode.className = 'ash-scm-input-editor';
		this.editorDomNode.style.height = `${this.height}px`;
		this.domNode.append(this.editorDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		// Create the enclosing scope before the editor so its focused context inherits SCM help.
		const context = this._register(contextKeyService.createScoped(this.domNode));
		const focused = context.createKey<boolean>('scmInputIsFocused', false);
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.editorDomNode,
			model: this.model,
			isSimpleWidget: true,
			presentation: 'embedded',
			fontFamily: DEFAULT_FONT_FAMILY,
			fontSize: 13,
			lineHeight: 20,
			wordWrap: 'on',
			padding: { top: 2, bottom: 2 },
			lineDecorationsWidth: 0,
			glyphMargin: false,
			folding: false,
			overviewRulerLanes: 0,
			scrollBeyondLastLine: false,
			tabFocusMode: true,
			readOnly: true,
			ariaLabel: localize('scm.input.label', 'Commit message'),
			contributions: EditorExtensionsRegistry.getSomeEditorContributions([PlaceholderTextContribution.ID]),
		}));
		this._register(this.editor.onDidFocusEditorText(() => {
			focused.set(true);
			this.domNode.classList.add('focused');
		}));
		this._register(this.editor.onDidBlurEditorText(() => {
			focused.set(false);
			this.domNode.classList.remove('focused');
		}));
		const layout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(this.model.onDidChangeContent(() => {
			if (this.boundInput) {
				this.boundInput.value = this.model.getText();
			}
			layout.schedule();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ScmInput)) {
				this.updateAriaLabel();
			}
		}));
		const observer = new ResizeObserver(() => layout.schedule());
		this._register(toDisposable(() => observer.disconnect()));
		observer.observe(this.editorDomNode);
		this.updateAriaLabel();
		layout.schedule();
	}

	public get input(): ISCMInput | undefined { return this.boundInput; }

	public set input(input: ISCMInput | undefined) {
		this.boundInput = input;
		const value = input?.value ?? '';
		if (this.model.getText() !== value) {
			this.model.setValue(value);
		}
		this.editor.updateOptions({ placeholder: input?.placeholder ?? '', readOnly: !input?.enabled });
		this.layout();
	}

	public focus(): void { this.editor.focus(); }

	public getContentHeight(): number {
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const padding = this.editor.getOption(EditorOption.padding);
		// Content height includes the viewport; the last line's bottom also lets the input shrink after deletion.
		const contentHeight = this.editor.getBottomForLineNumber(this.model.lineCount) + padding.bottom;
		return Math.min(10 * lineHeight + padding.top + padding.bottom, Math.max(lineHeight + padding.top + padding.bottom, contentHeight));
	}

	public layout(): void {
		const width = this.editorDomNode.clientWidth;
		if (width === 0) { return; }
		this.editor.layout({ width, height: this.height });
		const height = this.getContentHeight();
		if (height !== this.height) {
			this.height = height;
			this.editorDomNode.style.height = `${height}px`;
			this.editor.layout({ width, height });
		}
	}

	private updateAriaLabel(): void {
		let ariaLabel = localize('scm.input.label', 'Commit message');
		if (this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.ScmInput)) {
			ariaLabel = localize('scm.input.helpHint', '{0}. Press Alt+F1 for source control input help.', ariaLabel);
		}
		this.editor.updateOptions({ ariaLabel });
	}
}
