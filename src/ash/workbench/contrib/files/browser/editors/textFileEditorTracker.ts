import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

/** Revalidates visible file models after the window regains focus. */
export class TextFileEditorTracker extends Disposable {
	constructor(
		window: Window,
		@IEditorService editorService: IEditorService,
		@IFileTextModelService models: IFileTextModelService,
	) {
		super();
		this._register(addDisposableListener(window, 'focus', () => {
			const seen = new Set<string>();
			for (const input of editorService.visibleEditors) {
				if (input.resource.scheme !== 'file' && !isRemoteResource(input.resource)) continue;
				const key = input.resource.toString();
				if (seen.has(key)) continue;
				seen.add(key);
				void models.refresh(input.resource).catch(error => console.error('Could not refresh open file', error));
			}
		}));
	}
}
