import type {
	TurnChangesListResult,
	TurnChangesMutationResult,
	TurnChangesReadFileResult,
	TurnChangesReadResult,
} from "../../app-server/common/generated/index.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import type { ITurnChangesApi } from "../common/turnChangesApi.js";

export function createTurnChangesApi(): ITurnChangesApi {
	return {
		list: (params) => invoke<TurnChangesListResult>("ash:turn-changes:list", params),
		read: (params) => invoke<TurnChangesReadResult>("ash:turn-changes:read", params),
		readFile: (params) => invoke<TurnChangesReadFileResult>("ash:turn-changes:read-file", params),
		generateMessage: (params) => invoke<TurnChangesMutationResult>("ash:turn-changes:generate-message", params),
		updateDraft: (params) => invoke<TurnChangesMutationResult>("ash:turn-changes:update-draft", params),
		commit: (params) => invoke<TurnChangesMutationResult>("ash:turn-changes:commit", params),
		discardThread: (params) => invoke<TurnChangesMutationResult>("ash:turn-changes:discard-thread", params),
	};
}
