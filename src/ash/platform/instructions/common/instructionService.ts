import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { URI } from '../../../base/common/uri.js';

/** Metadata from the authorized catalog; App Server loads bodies when the Turn starts. */
export interface ChatInstruction {
	readonly path: string;
	readonly name: string;
	readonly description?: string;
	readonly scope: 'user' | 'directory';
	/** The catalog's owning host supplies resource identity when it differs from the window host. */
	readonly resource?: URI;
}

export type InstructionImportSource = 'copilot' | 'claude' | 'codex' | 'cursor';
export type InstructionImportStatus = 'ready' | 'unchanged' | 'conflict' | 'unsupported' | 'imported' | 'failed';

export interface InstructionImportSelection {
	readonly scope?: ChatInstruction['scope'];
	readonly directory: string;
	readonly source: InstructionImportSource;
	readonly sources: readonly string[];
}

export interface InstructionImportItem {
	readonly source: string;
	readonly target: string;
	readonly content: string;
	readonly status: InstructionImportStatus;
	readonly message?: string;
}

export interface InstructionImportPreview {
	readonly targetDirectory: URI;
	readonly digest: string;
	readonly items: readonly InstructionImportItem[];
	readonly diagnostics: readonly { readonly path: string; readonly message: string; }[];
}

/** Borrowed Session host. A reconnect or host retirement invalidates this import flow. */
export interface IInstructionImports {
	directories(scope?: InstructionImportSelection['scope']): Promise<readonly { readonly path: string; readonly resource: URI; readonly needsAccess: boolean; }[]>;
	/** Requires explicit consent for read, browse and write access by this Session tree. */
	grantAccess(directory: string): Promise<void>;
	preview(selection: InstructionImportSelection): Promise<InstructionImportPreview>;
	/** Publishes exactly the reviewed paths/digest; each result must be checked independently. */
	apply(selection: InstructionImportSelection, digest: string): Promise<readonly InstructionImportItem[]>;
}

export interface IInstructionService {
	readonly isAvailable: boolean;
	/** Omitted by hosts without the native project import authority. */
	captureImports?(sessionId: string): IInstructionImports;
	list(sessionId?: string): Promise<readonly ChatInstruction[]>;
}

export const IInstructionService = createServiceIdentifier<IInstructionService>('instructionService');
