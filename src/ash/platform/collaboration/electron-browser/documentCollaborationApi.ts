import type { DocumentCollaborationOpenResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationSubmitResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationPresenceSnapshot } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import type { IDocumentCollaborationApi } from "../common/documentCollaborationApi.js";

export function createDocumentCollaborationApi(): IDocumentCollaborationApi {
	return {
		open: params => invoke<DocumentCollaborationOpenResult>("ash:document:collaboration:open", params),
		submit: params => invoke<DocumentCollaborationSubmitResult>("ash:document:collaboration:submit", params),
		publishPresence: params => invoke<DocumentCollaborationPresenceSnapshot>("ash:document:collaboration:presence:publish", params),
		readPresence: params => invoke<DocumentCollaborationPresenceSnapshot>("ash:document:collaboration:presence:read", params),
	};
}
