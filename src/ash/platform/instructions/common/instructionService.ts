import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Metadata from the authorized catalog; App Server loads bodies when the Turn starts. */
export interface ChatInstruction {
	readonly path: string;
	readonly name: string;
	readonly description?: string;
	readonly scope: 'user' | 'directory';
}

export interface IInstructionService {
	readonly isAvailable: boolean;
	list(sessionId?: string): Promise<readonly ChatInstruction[]>;
}

export const IInstructionService = createServiceIdentifier<IInstructionService>('instructionService');
