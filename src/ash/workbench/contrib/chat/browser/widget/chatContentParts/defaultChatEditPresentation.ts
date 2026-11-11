import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { DiffEditorWidget } from '../../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { EditorOption } from '../../../../../../editor/common/config/editorOptions.js';
import { DiffModel } from '../../../../../../editor/common/diff/diffModel.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IDiffService } from '../../../../../services/diff/common/diffService.js';
import type { IChatEditDiff, IChatEditPresentation } from './chatEditPresentation.js';

/** Owns the read-only editor and documents for a mounted comparison in the transcript. */
export class DefaultChatEditPresentation extends Disposable implements IChatEditPresentation {
	private readonly editor: DiffEditorWidget;

	constructor(
		host: HTMLElement,
		data: IChatEditDiff,
		layout: (height: number) => void,
		@IInstantiationService instantiation: IInstantiationService,
		@IDiffService diffs: IDiffService,
		@ILanguageService languages: ILanguageService,
	) {
		super();
		try {
			const languageId = languages.getRegisteredLanguageIds().includes(data.languageId)
				? data.languageId : languages.getLanguageIdByLanguageName(data.languageId) ?? 'plaintext';
			const original = this._register(new TextModel(data.beforeContent, { languageId, isForSimpleWidget: true }));
			const modified = this._register(new TextModel(data.afterContent, { languageId, isForSimpleWidget: true }));
			const model = this._register(new DiffModel({
				original, modified, diffProvider: this._register(diffs.createComputationService()),
				diffOptions: { ignoreTrimWhitespace: false, maxComputationTimeMs: 1000, computeMoves: false },
			}));
			this.editor = this._register(instantiation.createInstance(DiffEditorWidget, {
				container: host, model, readOnly: true, scrollBeyondLastLine: false,
				useInlineViewWhenSpaceIsLimited: true, renderMarginRevertIcon: false, renderGutterMenu: false,
				renderOverviewRuler: false, showLineNumbers: false,
			}));
			const resize = () => {
				const lineHeight = this.editor.modifiedEditor.getOption(EditorOption.lineHeight);
				layout(Math.max(lineHeight, Math.min(this.editor.getContentHeight(), lineHeight * 20)));
			};
			this._register(this.editor.onDidContentSizeChange(resize));
			resize();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	focus(original = false): void {
		const editor = original && !this.editor.element.classList.contains('inline-view')
			? this.editor.originalEditor : this.editor.modifiedEditor;
		editor.focus();
	}
}
