import { type LanguageDiagnosticsSource } from '../../../src/ash/editor/common/languages.js';
import { Disposable } from '../../../src/ash/base/common/lifecycle.js';
import { IMarkerDecorationsService } from '../../../src/ash/editor/common/services/markerDecorations.js';
import { type IEditorContribution } from '../../../src/ash/editor/common/editorCommon.js';
import { type ICodeEditor } from '../../../src/ash/editor/browser/editorBrowser.js';

/** Holds the shared marker decorations for this editor's attached model. */
export class MarkerDecorationsContribution extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.markerDecorations';

	constructor(editor: ICodeEditor, diagnostics: LanguageDiagnosticsSource | undefined, @IMarkerDecorationsService markerDecorationsService: IMarkerDecorationsService) {
		super();
		const model = editor.getModel();
		if (model) this._register(markerDecorationsService.acquire(model, diagnostics));
	}
}
