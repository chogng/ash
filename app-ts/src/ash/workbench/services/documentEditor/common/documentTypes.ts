import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITextModelResourceService, TextModelBlockInput, TextModelWorkingCopyReference } from '../../textmodelResolver/common/textModelResourceService.js';

export interface DocumentType {
	readonly id: string;
	readonly contentType: string;
	readonly extensions: readonly string[];
}

/** Shared file routing consumes type declarations without depending on document contributions. */
export const DocumentTypes = new class {
	private readonly types = new Map<string, DocumentType>();

	public register(type: DocumentType): void {
		if (this.types.has(type.id)) { throw new Error(`Document type is already registered: ${type.id}`); }
		this.types.set(type.id, type);
	}

	public find(input: { readonly resource: URI; readonly contentType?: string }): DocumentType | undefined {
		if (input.contentType !== undefined) {
			return [...this.types.values()].find(type => type.contentType === input.contentType);
		}
		const path = input.resource.path.toLowerCase();
		return [...this.types.values()].find(type => type.extensions.some(extension => path.endsWith(extension)));
	}
};

export interface IDocumentEditorTextModelService extends ITextModelResourceService<TextModelBlockInput, TextModelWorkingCopyReference> {}
export const IDocumentEditorTextModelService = createServiceIdentifier<IDocumentEditorTextModelService>('documentEditorTextModelService');
