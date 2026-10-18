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

export interface IInstructionService {
	readonly isAvailable: boolean;
	list(sessionId?: string): Promise<readonly ChatInstruction[]>;
}

export const IInstructionService = createServiceIdentifier<IInstructionService>('instructionService');
