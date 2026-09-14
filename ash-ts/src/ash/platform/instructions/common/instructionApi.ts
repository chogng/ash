import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type InstructionSource = { readonly type: 'user' } | { readonly type: 'directory'; readonly root: string };

export interface InstructionReference {
	readonly source: InstructionSource;
	readonly relativePath: string;
	readonly digest: string;
}

export interface InstructionDescriptor {
	readonly reference: InstructionReference;
	readonly name: string;
	readonly loadPolicy: 'global' | 'contextual' | 'onDemand';
	readonly path: string;
}

export interface InstructionCatalog {
	readonly instructions: readonly InstructionDescriptor[];
	readonly diagnostics: readonly {
		readonly source: InstructionSource;
		readonly relativePath?: string;
		readonly code: 'sourceUnavailable' | 'entryLimitExceeded' | 'unsupportedFileType' | 'symlinkNotAllowed' | 'invalidName' | 'invalidFrontmatter' | 'invalidLoadPolicy' | 'contentTooLarge' | 'contentInvalidUtf8' | 'emptyBody';
		readonly message: string;
	}[];
}

/** Lists Ash-owned Instructions available to one Session. */
export interface IInstructionApi {
	list(sessionId?: string): Promise<InstructionCatalog>;
}

export const IInstructionApi = createServiceIdentifier<IInstructionApi>('instructionApi');
