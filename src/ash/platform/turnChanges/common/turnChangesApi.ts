import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

type TurnChangeCaptureState = 'open' | 'sealed' | 'incomplete' | 'discarded';
type TurnChangeMessageState = 'unconfigured' | 'queued' | 'generating' | 'ready' | 'failed';
type TurnChangeCommitState = 'idle' | 'queued' | 'committing' | 'recovering' | 'recoveryUnavailable' | 'committed' | 'partiallyCommitted' | 'conflict' | 'failed';

export interface TurnChangeSetSummary {
	readonly changeSetId: string;
	readonly sessionId: string;
	readonly threadId: string;
	readonly turnId: string;
	readonly repositoryId: string;
	readonly targetBranch?: string;
	readonly statistics: { readonly files: number; readonly additions: number; readonly deletions: number; };
	readonly captureState: TurnChangeCaptureState;
	readonly messageState: TurnChangeMessageState;
	readonly commitState: TurnChangeCommitState;
	readonly committedPaths: readonly string[];
	readonly terminalState?: 'completed' | 'failed' | 'interrupted';
	readonly dependencies: readonly string[];
	readonly externalDependencyPaths: readonly string[];
	readonly warnings: readonly string[];
	readonly conflictPaths: readonly string[];
	readonly failureMessage?: string;
	readonly commitId?: string;
	readonly revision: number;
}

export interface TurnChangeFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'typeChanged';
	readonly beforeMode?: string;
	readonly afterMode?: string;
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
}

export interface TurnChangeDetails {
	readonly summary: TurnChangeSetSummary;
	readonly files: readonly TurnChangeFile[];
	readonly generatedMessage?: string;
	readonly draftMessage?: string;
}

/** Net changes from this conversation's baseline to its current history checkpoint. */
export interface ThreadChangesSummary {
	readonly sequence: number;
	readonly revision: string;
	/** Verified checkout root, present only while the current directory grant permits it. */
	readonly worktreePath?: string;
	readonly statistics: TurnChangeSetSummary['statistics'];
	readonly repositories: readonly { readonly repositoryId: string; readonly files: readonly TurnChangeFile[]; }[];
	readonly warnings: readonly string[];
}

export interface TurnChangeFileContents {
	readonly path: string;
	readonly binary: boolean;
	readonly truncated: boolean;
	readonly before?: string;
	readonly after?: string;
}

export interface TurnCommitSelection {
	readonly changeSetId: string;
	readonly expectedRevision: number;
	readonly paths: readonly string[];
}

export interface TurnCommitPreview {
	readonly commitId: string;
	readonly targetBranch: string;
	readonly message: string;
	readonly files: readonly TurnChangeFile[];
	readonly warnings: readonly string[];
}

export interface TurnChangesUpdate {
	readonly sessionId: string;
	readonly threadId: string;
	readonly changeSets: readonly TurnChangeSetSummary[];
}

interface ThreadTarget { readonly sessionId: string; readonly threadId: string; }
interface ChangeTarget extends ThreadTarget { readonly changeSetId: string; }
interface ChangeMutation extends ChangeTarget { readonly commandId: string; readonly expectedRevision: number; }
interface CommitTarget extends ThreadTarget { readonly commitId: string; }
interface ChangeSetList { readonly changeSets: readonly TurnChangeSetSummary[]; }

/** Transport-neutral access to the App Server Turn change ledger. */
export interface ITurnChangesApi {
	readonly onDidChange: Event<TurnChangesUpdate>;
	list(params: ThreadTarget): Promise<ChangeSetList>;
	summary(params: ThreadTarget): Promise<ThreadChangesSummary>;
	summaryFile(params: ThreadTarget & { readonly revision: string; readonly repositoryId: string; readonly path: string; }): Promise<TurnChangeFileContents>;
	read(params: ChangeTarget): Promise<TurnChangeDetails>;
	readFile(params: ChangeTarget & { readonly path: string; }): Promise<TurnChangeFileContents>;
	generateMessage(params: ChangeMutation): Promise<ChangeSetList>;
	updateDraft(params: ChangeMutation & { readonly message: string; }): Promise<ChangeSetList>;
	prepareCommit(params: ThreadTarget & { readonly commandId: string; readonly selections: readonly TurnCommitSelection[]; readonly message: string; }): Promise<TurnCommitPreview>;
	readCommit(params: CommitTarget): Promise<TurnCommitPreview>;
	readCommitFile(params: CommitTarget & { readonly path: string; }): Promise<TurnChangeFileContents>;
	commit(params: CommitTarget & { readonly commandId: string; }): Promise<ChangeSetList>;
	discardThread(params: ThreadTarget & { readonly commandId: string; readonly expectedRevision: number; readonly confirmed: boolean; }): Promise<ChangeSetList>;
}

export const ITurnChangesApi = createServiceIdentifier<ITurnChangesApi>('TurnChangesApi');
