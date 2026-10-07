import type {
	TurnChangesCommitParams,
	TurnChangesPrepareCommitParams,
	TurnChangesPrepareCommitResult,
	TurnChangesReadCommitParams,
	TurnChangesReadCommitFileParams,
	TurnChangesDiscardThreadParams,
	TurnChangesListParams,
	TurnChangesListResult,
	TurnChangesMutationParams,
	TurnChangesMutationResult,
	TurnChangesReadFileParams,
	TurnChangesReadFileResult,
	TurnChangesReadParams,
	TurnChangesReadResult,
	TurnChangesUpdateDraftParams,
} from "../../../../../crates/app-server-protocol/schema/typescript/index.js";

/** Transport-neutral access to the App Server Turn change ledger. */
export interface ITurnChangesApi {
	list(params: TurnChangesListParams): Promise<TurnChangesListResult>;
	read(params: TurnChangesReadParams): Promise<TurnChangesReadResult>;
	readFile(params: TurnChangesReadFileParams): Promise<TurnChangesReadFileResult>;
	generateMessage(params: TurnChangesMutationParams): Promise<TurnChangesMutationResult>;
	updateDraft(params: TurnChangesUpdateDraftParams): Promise<TurnChangesMutationResult>;
	prepareCommit(params: TurnChangesPrepareCommitParams): Promise<TurnChangesPrepareCommitResult>;
	readCommit(params: TurnChangesReadCommitParams): Promise<TurnChangesPrepareCommitResult>;
	readCommitFile(params: TurnChangesReadCommitFileParams): Promise<TurnChangesReadFileResult>;
	commit(params: TurnChangesCommitParams): Promise<TurnChangesMutationResult>;
	discardThread(params: TurnChangesDiscardThreadParams): Promise<TurnChangesMutationResult>;
}
