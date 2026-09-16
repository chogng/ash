import type {
	TurnChangesCommitParams,
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
} from "../../app-server/common/generated/index.js";

/** Transport-neutral access to the App Server Turn change ledger. */
export interface ITurnChangesApi {
	list(params: TurnChangesListParams): Promise<TurnChangesListResult>;
	read(params: TurnChangesReadParams): Promise<TurnChangesReadResult>;
	readFile(params: TurnChangesReadFileParams): Promise<TurnChangesReadFileResult>;
	generateMessage(params: TurnChangesMutationParams): Promise<TurnChangesMutationResult>;
	updateDraft(params: TurnChangesUpdateDraftParams): Promise<TurnChangesMutationResult>;
	commit(params: TurnChangesCommitParams): Promise<TurnChangesMutationResult>;
	discardThread(params: TurnChangesDiscardThreadParams): Promise<TurnChangesMutationResult>;
}
