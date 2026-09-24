import { toDisposable, type IDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import {
	createResolvedTextEditorModelReference,
	ITextModelService,
	type IResolvedTextEditorModel,
	type ITextModelContentProvider,
} from '../../../../editor/common/services/resolverService.js';
import {
	ITextModelResourceService,
	type ITextModelResourceService as ITextModelResourceServiceContract,
} from './textModelResourceService.js';

/** Resolves Workbench resources through the existing reference-counted text model owner. */
export class TextModelResolverService implements ITextModelService {
	declare readonly _serviceBrand: undefined;
	private readonly contentProviders = new Map<string, ITextModelContentProvider>();
	private readonly providerModelReferences = new Map<ITextModel, number>();

	constructor(@ITextModelResourceService private readonly models: ITextModelResourceServiceContract) {}

	async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
		const provider = this.contentProviders.get(resource.scheme);
		if (provider) {
			const model = await provider.provideTextContent(resource);
			if (!model) throw new ReferenceError(`Text model not found: ${resource.toString()}`);
			this.providerModelReferences.set(model, (this.providerModelReferences.get(model) ?? 0) + 1);
			return createResolvedTextEditorModelReference(model, () => this.releaseProviderModel(model));
		}
		const reference = await this.models.acquire({ resource }, new AbortController().signal);
		return createResolvedTextEditorModelReference(reference.model, () => reference.dispose());
	}

	registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider): IDisposable {
		if (this.contentProviders.has(scheme)) throw new Error(`Text model content provider already registered: ${scheme}`);
		this.contentProviders.set(scheme, provider);
		return toDisposable(() => {
			if (this.contentProviders.get(scheme) === provider) this.contentProviders.delete(scheme);
		});
	}

	canHandleResource(resource: URI): boolean {
		return resource.scheme === 'file' || this.contentProviders.has(resource.scheme);
	}

	private releaseProviderModel(model: ITextModel): void {
		const references = this.providerModelReferences.get(model);
		if (references === undefined) return;
		if (references > 1) {
			this.providerModelReferences.set(model, references - 1);
			return;
		}
		this.providerModelReferences.delete(model);
		model.dispose();
	}
}
