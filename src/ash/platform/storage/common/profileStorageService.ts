import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IProfileStorageService = createDecorator<IProfileStorageService>('profileStorageService');
export const desktopStorageChannelName = 'desktopStorage';

export interface DesktopStorageUsage {
	readonly root: string;
	readonly bytes: number;
	readonly complete: boolean;
}

export interface ProfileStorageOverview {
	readonly profileRoot: string;
	readonly worktreeRoot: string;
	readonly desktopRoot: string | undefined;
	readonly worktreeBytes: number;
	readonly sessionBytes: number;
	readonly otherBytes: number;
	readonly complete: boolean;
	readonly worktrees: readonly ProfileStorageWorktree[];
}

export interface ProfileStorageWorktree {
	readonly sessionId: string;
	readonly threadId: string;
	readonly revision: number;
	readonly path: string;
	readonly title: string;
	readonly sizeBytes: number | null;
}

export interface IProfileStorageService {
	readonly _serviceBrand: undefined;
	readOverview(signal: AbortSignal): Promise<ProfileStorageOverview>;
	cleanWorktree(worktree: ProfileStorageWorktree): Promise<void>;
}
