import { type LanguageDiagnosticsSource } from '../../common/services/languageDiagnosticsService.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IMarkerDecorationsService } from '../../common/services/markerDecorations.js';
import { type IEditorContribution } from '../../common/editorCommon.js';
import { type ICodeEditor } from '../editorBrowser.js';

/** Holds the shared marker decorations for this editor's attached model. */
export class MarkerDecorationsContribution extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.markerDecorations';

	constructor(editor: ICodeEditor, diagnostics: LanguageDiagnosticsSource | undefined, @IMarkerDecorationsService markerDecorationsService: IMarkerDecorationsService) {
		super();
		const model = editor.getModel();
		if (model) this._register(markerDecorationsService.acquire(model, diagnostics));
	}
}
