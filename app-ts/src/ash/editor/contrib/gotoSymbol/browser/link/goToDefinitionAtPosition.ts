import './goToDefinitionAtPosition.css';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { type ICodeEditor, MouseTargetType } from '../../../../browser/editorBrowser.js';
import { registerEditorContribution } from '../../../../browser/editorExtensions.js';
import { ILanguageFeaturesService } from '../../../../common/services/languageFeatures.js';
import { type View } from '../../../../browser/view.js';
import { Range } from '../../../../common/core/range.js';
import { getDefinitionsAtPosition } from '../goToSymbol.js';
import { ReferencesController } from '../peek/referencesController.js';
import { LinkDetector } from '../../../links/browser/links.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { ClickLinkGesture, type ClickLinkMouseEvent, type ClickLinkKeyboardEvent } from './clickLinkGesture.js';

export class GotoDefinitionAtPositionEditorContribution extends Disposable {
	public static readonly ID = 'editor.contrib.gotodefinitionatposition';
	public static get(editor: ICodeEditor): GotoDefinitionAtPositionEditorContribution | null {
		return editor.getContribution<GotoDefinitionAtPositionEditorContribution>(GotoDefinitionAtPositionEditorContribution.ID);
	}
	private readonly decorations;
	private request: AbortController | undefined;
	private word: string | undefined;

	constructor(private readonly editor: ICodeEditor, private readonly viewport: View, private readonly onError: (error: unknown) => void, @ILanguageFeaturesService private readonly features: ILanguageFeaturesService) {
		super();
		this.decorations = editor.createDecorationsCollection();
		this._register(toDisposable(() => this.clear()));
		const gesture = this._register(new ClickLinkGesture(editor));
		this._register(gesture.onMouseMoveOrRelevantKeyDown(([mouse, keyboard]) => void this.preview(mouse, keyboard)));
		this._register(gesture.onCancel(() => this.clear()));
		this._register(gesture.onExecute(mouse => {
			if (mouse.target.type !== MouseTargetType.CONTENT_TEXT || !this.features.definitionProvider.has(viewport.textModel)
				|| LinkDetector.get(editor)?.getLinkOccurrence(mouse.target.position)) { return; }
			this.clear();
			editor.setPosition(mouse.target.position);
			void ReferencesController.get(editor)?.navigate('definition', {
				peek: !mouse.hasSideBySideModifier && editor.getOption(EditorOption.definitionLinkOpensInPeek) === true,
				openToSide: mouse.hasSideBySideModifier,
			}).catch(this.onError);
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.clear()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.clear()));
		this._register(features.definitionProvider.onDidChange(() => this.clear()));
		this._register(editor.onDidScrollChange(() => this.clear()));
	}
	private async preview(mouse: ClickLinkMouseEvent, keyboard: ClickLinkKeyboardEvent | null): Promise<void> {
		if (mouse.target.type !== MouseTargetType.CONTENT_TEXT || !(keyboard?.hasTriggerModifier ?? mouse.hasTriggerModifier)
			|| LinkDetector.get(this.editor)?.getLinkOccurrence(mouse.target.position)) { this.clear(); return; }
		const position = mouse.target.position;
		const model = this.viewport.textModel;
		const word = model.getWordAtPosition(position);
		if (!word || !this.features.definitionProvider.has(model)) { this.clear(); return; }
		const identity = `${model.version}:${position.lineNumber}:${word.startColumn}`;
		if (identity === this.word) { return; }
		this.clear();
		this.word = identity;
		const request = this.request = new AbortController();
		try {
			const links = await getDefinitionsAtPosition(this.features.definitionProvider, model, position, false, request.signal, this.onError);
			if (request.signal.aborted || links.length === 0) { return; }
			this.decorations.set([{ range: new Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), options: { description: 'definition-link', inlineClassName: 'stanza-editor-definition-link' } }]);
		} catch (error) {
			if (!request.signal.aborted) { this.onError(error); }
		}
	}
	private clear(): void {
		this.request?.abort();
		this.request = undefined;
		this.word = undefined;
		this.decorations.clear();
	}
}

registerEditorContribution({
	id: GotoDefinitionAtPositionEditorContribution.ID, install: context => {
		if (context.kind !== 'text') { return; }
		return context.instantiationService.createInstance(GotoDefinitionAtPositionEditorContribution, context.editor, context.view, context.onLanguageError);
	}
});
