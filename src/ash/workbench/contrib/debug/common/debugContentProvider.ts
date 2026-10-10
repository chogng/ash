import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService, type ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IDebugService } from '../../../services/debug/common/debugService.js';

/** Loads adapter source content into the existing reference-counted editor model owner. */
export class DebugContentProvider extends Disposable implements IWorkbenchContribution, ITextModelContentProvider {
	private readonly pending = new Map<string, Promise<ITextModel>>();

	constructor(
		@IDebugService private readonly debug: IDebugService,
		@ITextModelService textModels: ITextModelService,
		@IModelService private readonly models: IModelService,
		@ILanguageService private readonly languages: ILanguageService,
	) {
		super();
		this._register(textModels.registerTextModelContentProvider('debug', this));
	}

	provideTextContent(resource: URI): Promise<ITextModel> {
		this.assertNotDisposed();
		const address = /^session=([A-Za-z0-9._-]{1,256})&ref=([1-9]\d{0,15})$/.exec(resource.query);
		const sessionId = address?.[1];
		const sourceReference = Number(address?.[2]);
		if (resource.scheme !== 'debug' || !sessionId || !Number.isSafeInteger(sourceReference) || sourceReference < 1) {
			return Promise.reject(new TypeError(localize('debug.invalidSource', 'The debug source needs a path or a source reference and a live session.')));
		}
		const session = this.debug.getSession(sessionId);
		if (!session || session.state === 'terminated' || session.state === 'error') {
			return Promise.reject(new Error(localize('debug.sourceSessionEnded', 'This debug source cannot be loaded because its session has ended.')));
		}
		const key = resource.toString();
		const existing = this.models.getModel(resource);
		if (existing) return Promise.resolve(existing);
		const pending = this.pending.get(key);
		if (pending) return pending;
		const operation = (async (): Promise<ITextModel> => {
			const content = await session.source({ sourceReference, path: resource.path });
			// A source reply can arrive after stop or window disposal. It must not create an orphan model.
			if (this.isDisposed || this.debug.getSession(sessionId) !== session || session.state === 'terminated' || session.state === 'error') throw new CancellationError();
			return this.models.getModel(resource) ?? this.models.createModel(content.content,
				content.mimeType ? this.languages.createByMimeType(content.mimeType) : this.languages.createByFilepathOrFirstLine(resource, content.content.split('\n', 1)[0]), resource);
		})();
		this.pending.set(key, operation);
		void operation.finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); }).catch(() => { /* The acquiring editor owns the failure. */ });
		return operation;
	}
}
