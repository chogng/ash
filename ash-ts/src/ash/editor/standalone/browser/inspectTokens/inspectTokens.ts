import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { StandardTokenType } from '../../../common/encodedTokenAttributes.js';
import type { IEditorContribution } from '../../../common/editorCommon.js';
import type { ITextModel } from '../../../common/model.js';
import type { LanguageToken } from '../../../common/tokens/languageTokens.js';
import './inspectTokens.css';

class InspectTokensController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.inspectTokens';
	private readonly widget = this._register(new MutableDisposable<InspectTokensWidget>());

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onDidChangeModel(() => this.widget.clear()));
		this._register(editor.onKeyDown(event => {
			if (!this.widget.value || event.keyCode !== KeyCode.Escape) return;
			event.stop();
			this.widget.clear();
		}));
	}

	public open(): void {
		if (this.widget.value || !this.editor.hasModel()) return;
		this.widget.value = new InspectTokensWidget(this.editor);
	}
}

class InspectTokensAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.inspectTokens',
			label: localize2('inspectTokens.label', 'Developer: Inspect Tokens'),
			precondition: undefined,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		editor.getContribution<InspectTokensController>(InspectTokensController.ID)?.open();
	}
}

class InspectTokensWidget extends Disposable implements IContentWidget {
	private readonly node: HTMLDivElement;
	private readonly sample: HTMLElement;
	private readonly language: HTMLElement;
	private readonly scope: HTMLElement;
	private readonly modifiers: HTMLElement;
	private readonly foreground: HTMLElement;
	private readonly model: ITextModel;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this.model = editor.getModel()!;
		const doc = editor.getContainerDomNode().ownerDocument;
		this.node = doc.createElement('div');
		this.node.className = 'stanza-editor-inspect-tokens';
		this.node.setAttribute('role', 'status');
		this.node.setAttribute('aria-live', 'polite');
		this.node.setAttribute('aria-label', localize('inspectTokens.title', 'Token details'));
		const heading = doc.createElement('strong');
		heading.className = 'stanza-editor-inspect-tokens-heading';
		heading.textContent = localize('inspectTokens.title', 'Token details');
		this.sample = doc.createElement('code');
		this.sample.className = 'stanza-editor-inspect-tokens-sample';
		const details = doc.createElement('dl');
		this.language = this.addDetail(details, localize('inspectTokens.language', 'Language'));
		this.scope = this.addDetail(details, localize('inspectTokens.scope', 'Token type'));
		this.modifiers = this.addDetail(details, localize('inspectTokens.modifiers', 'Modifiers'));
		this.foreground = this.addDetail(details, localize('inspectTokens.foreground', 'Foreground'));
		this.node.append(heading, this.sample, details);
		this._register(this.model.onDidChangeTokens(() => this.update()));
		this._register(editor.onDidChangeModelContent(() => this.update()));
		this._register(editor.onDidChangeCursorPosition(() => this.update()));
		this.update();
		editor.addContentWidget(this);
		this._register(toDisposable(() => editor.removeContentWidget(this)));
		editor.layoutContentWidget(this);
	}

	public getId(): string {
		return 'editor.contrib.inspectTokensWidget';
	}

	public getDomNode(): HTMLElement {
		return this.node;
	}

	public getPosition(): IContentWidgetPosition | null {
		const position = this.editor.getPosition();
		return position ? { position, preference: [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW] } : null;
	}

	private addDetail(parent: HTMLDListElement, label: string): HTMLElement {
		const term = parent.ownerDocument.createElement('dt');
		term.textContent = label;
		const value = parent.ownerDocument.createElement('dd');
		parent.append(term, value);
		return value;
	}

	private update(): void {
		const position = this.editor.getPosition();
		if (!position) return;
		const line = this.model.getLineContent(position.lineNumber);
		const column = Math.min(position.column, Math.max(1, line.length));
		const tokens = this.model.tokenization.getLineTokens(position.lineNumber);
		const index = tokens.findTokenIndexAtOffset(column - 1);
		const token = this.model.tokenization.getLanguageTokens(position.lineNumber - 1).find(candidate =>
			candidate.range.startColumn <= column && column < candidate.range.endColumn);
		this.sample.textContent = token ? this.model.getValueInRange(token.range) : tokens.getTokenText(index);
		this.language.textContent = token?.languageId ?? tokens.getLanguageId(index);
		this.scope.textContent = this.model.tokenization.hasAccurateTokensForLine(position.lineNumber)
			? token?.tokenType ?? standardTokenType(tokens.getStandardTokenType(index))
			: localize('inspectTokens.analyzing', 'Analyzing…');
		this.modifiers.textContent = token?.modifiers.join(', ') || '—';
		this.foreground.textContent = token?.presentation?.foreground ?? '—';
		this.editor.layoutContentWidget(this);
	}
}

function standardTokenType(type: StandardTokenType): string {
	switch (type) {
		case StandardTokenType.Comment: return localize('inspectTokens.comment', 'Comment');
		case StandardTokenType.String: return localize('inspectTokens.string', 'String');
		case StandardTokenType.RegEx: return localize('inspectTokens.regex', 'Regular expression');
		default: return localize('inspectTokens.other', 'Other');
	}
}

registerEditorContribution(InspectTokensController.ID, InspectTokensController, EditorContributionInstantiation.Lazy);
registerEditorAction(InspectTokensAction);
