import { toDisposable, type IDisposable, type IReference } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { ITextModel } from '../model.js';
import { IModelService, type IModelService as IModelServiceContract } from './model.js';
import {
	createResolvedTextEditorModelReference,
	type IResolvedTextEditorModel,
	type ITextModelContentProvider,
	type ITextModelService,
} from './resolverService.js';

/** Resolves standalone models by resource without taking ownership of caller-created models. */
export class InMemoryTextModelService implements ITextModelService {
	declare readonly _serviceBrand: undefined;
	private readonly contentProviders = new Map<string, ITextModelContentProvider>();
	private readonly providerModelReferences = new Map<ITextModel, number>();

	constructor(@IModelService private readonly models: IModelServiceContract) {}

	async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
		const existing = this.models.getModel(resource);
		if (existing) return createResolvedTextEditorModelReference(existing, () => {});
		const provider = this.contentProviders.get(resource.scheme);
		if (!provider) throw new ReferenceError(`Text model not found: ${resource.toString()}`);
		const model = await provider.provideTextContent(resource);
		if (!model) throw new ReferenceError(`Text model not found: ${resource.toString()}`);
		this.providerModelReferences.set(model, (this.providerModelReferences.get(model) ?? 0) + 1);
		return createResolvedTextEditorModelReference(model, () => this.releaseProviderModel(model));
	}

	registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider): IDisposable {
		if (this.contentProviders.has(scheme)) throw new Error(`Text model content provider already registered: ${scheme}`);
		this.contentProviders.set(scheme, provider);
		return toDisposable(() => {
			if (this.contentProviders.get(scheme) === provider) this.contentProviders.delete(scheme);
		});
	}

	canHandleResource(resource: URI): boolean {
		return this.models.getModel(resource) !== null || this.contentProviders.has(resource.scheme);
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
