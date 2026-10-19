import type { DocumentNode } from '../../../../../../extensions/academic/common/model/document.js';
import type { ChannelReference } from '../../../../platform/collaboration/common/channelService.js';
import type { URI } from '../../../../base/common/uri.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITextModelResourceService, TextModelBlockInput, TextModelWorkingCopyReference } from '../../textmodelResolver/common/textModelResourceService.js';
import type { IEditorPane } from '../../../common/editor.js';
import type { CallDocument } from '../../../../platform/call/common/callService.js';

/** Document-pane operations used by Calls and Channels. Models remain editor-owned. */
export interface IDocumentCollaborationEditor extends IEditorPane {
	getCollaborationDocument(): CallDocument | undefined;
	joinCollaborationDocument(document: CallDocument, channel?: ChannelReference): Promise<void>;
}

export function isDocumentCollaborationEditor(pane: IEditorPane | undefined): pane is IDocumentCollaborationEditor {
	const candidate = pane as Partial<IDocumentCollaborationEditor> | undefined;
	return typeof candidate?.getCollaborationDocument === 'function' && typeof candidate.joinCollaborationDocument === 'function';
}

export interface DocumentType {
	readonly id: string;
	readonly contentType: string;
	readonly extensions: readonly string[];
}

/** Shared file routing consumes type declarations without depending on document contributions. */
export const DocumentTypes = new class {
	private readonly types = new Map<string, DocumentType>();
	private readonly reservations = new Set<readonly Pick<DocumentType, 'contentType' | 'extensions'>[]>();

	/** Package declarations protect resources even when execution is disabled or unavailable. */
	public reserveTypes(types: readonly Pick<DocumentType, 'contentType' | 'extensions'>[]): IDisposable {
		this.reservations.add(types);
		return toDisposable(() => this.reservations.delete(types));
	}

	public requiresProvider(input: { readonly resource: URI; readonly contentType?: string; }): boolean {
		const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
		return this.find(input) !== undefined || [...this.reservations].some(types => types.some(type =>
			mediaType === type.contentType || type.extensions.some(extension => input.resource.path.toLowerCase().endsWith(extension))));
	}

	/** Routing declarations have the same lifetime as their available editor panes. */
	public registerTypes(): IDisposable & { replace(types: readonly DocumentType[]): void; } {
		let owned: readonly DocumentType[] = [];
		const replace = (types: readonly DocumentType[]): void => {
			const identifiers = new Set<string>();
			for (const type of types) {
				const existing = this.types.get(type.id);
				if (identifiers.has(type.id) || existing && !owned.includes(existing)) {
					throw new Error(`Document type is already registered: ${type.id}`);
				}
				identifiers.add(type.id);
			}
			for (const type of owned) { this.types.delete(type.id); }
			owned = [...types];
			for (const type of owned) { this.types.set(type.id, type); }
		};
		return Object.assign(toDisposable(() => replace([])), { replace });
	}

	public find(input: { readonly resource: URI; readonly contentType?: string; }): DocumentType | undefined {
		if (input.contentType !== undefined) {
			return [...this.types.values()].find(type => type.contentType === input.contentType);
		}
		const path = input.resource.path.toLowerCase();
		return [...this.types.values()].find(type => type.extensions.some(extension => path.endsWith(extension)));
	}
};

export interface IDocumentEditorTextModelService extends ITextModelResourceService<TextModelBlockInput, TextModelWorkingCopyReference> {
	/** A remote authority saved this exact snapshot; newer local edits remain dirty. */
	acceptCollaborationSnapshot(resource: URI, document: DocumentNode): void;
}
export const IDocumentEditorTextModelService = createServiceIdentifier<IDocumentEditorTextModelService>('documentEditorTextModelService');
