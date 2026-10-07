import { CancellationError } from '../../../base/common/errors.js';
import type { URI } from '../../../base/common/uri.js';
import { ITextModelService, type IResolvedTextEditorModel } from '../../../editor/common/services/resolverService.js';
import { AbstractResourceEditorInput } from './resourceEditorInput.js';

/** Owns a single resolver reference; separate inputs can share the resolver's text model. */
export class TextResourceEditorInput extends AbstractResourceEditorInput {
	public static readonly ID = 'workbench.editors.resourceEditorInput';
	public readonly typeId = TextResourceEditorInput.ID;
	public readonly readOnly = true;
	private resolution: Promise<IResolvedTextEditorModel> | undefined;

	constructor(resource: URI, private readonly name: string | undefined, @ITextModelService private readonly textModelService: ITextModelService) {
		super(resource);
	}

	public override getName(): string {
		return this.name ?? super.getName();
	}

	public resolve(): Promise<IResolvedTextEditorModel> {
		this.assertNotDisposed();
		return this.resolution ??= this.resolveModel();
	}

	protected override disposeCore(): void {
		this.resolution = undefined;
		super.disposeCore();
	}

	private async resolveModel(): Promise<IResolvedTextEditorModel> {
		try {
			const reference = await this.textModelService.createModelReference(this.resource);
			// Providers cannot be cancelled. A result that arrives after close must still be released.
			if (this.isDisposed) {
				reference.dispose();
				throw new CancellationError();
			}
			this._register(reference);
			return reference.object;
		} catch (error) {
			this.resolution = undefined;
			throw error;
		}
	}
}
