import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type InstructionImportScope =
	| { readonly type: 'user' }
	| { readonly type: 'workspace' };

export interface InstructionImportSource {
	readonly relativePath: string;
	readonly content: string;
	readonly sha256: string;
}

export interface InstructionImportPreview {
	readonly source?: InstructionImportSource;
	readonly target: string;
	readonly targetConflict: boolean;
	readonly diagnostics: readonly { readonly relativePath: string; readonly code: string }[];
}

/** Preview and confirm a deterministic Claude Instruction file copy. */
export interface IInstructionImportApi {
	preview(scope: InstructionImportScope): Promise<InstructionImportPreview>;
	apply(scope: InstructionImportScope, source: InstructionImportSource, expectedTarget: string): Promise<{ readonly target: string; readonly sha256: string }>;
}

export const IInstructionImportApi = createServiceIdentifier<IInstructionImportApi>('instructionImportApi');
