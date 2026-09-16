import type { DocumentCollaborationOpenParams } from "../../app-server/common/generated/index.js";
import type { DocumentCollaborationOpenResult } from "../../app-server/common/generated/index.js";
import type { DocumentCollaborationPresenceParams } from "../../app-server/common/generated/index.js";
import type { DocumentCollaborationPresenceReadParams } from "../../app-server/common/generated/index.js";
import type { DocumentCollaborationPresenceSnapshot } from "../../app-server/common/generated/index.js";
import type { DocumentCollaborationSubmitParams } from "../../app-server/common/generated/index.js";
import type { DocumentCollaborationSubmitResult } from "../../app-server/common/generated/index.js";

/** Typed transport boundary for server-ordered structured-document collaboration. */
export interface IDocumentCollaborationApi {
	open(params: DocumentCollaborationOpenParams): Promise<DocumentCollaborationOpenResult>;
	submit(params: DocumentCollaborationSubmitParams): Promise<DocumentCollaborationSubmitResult>;
	publishPresence(params: DocumentCollaborationPresenceParams): Promise<DocumentCollaborationPresenceSnapshot>;
	readPresence(params: DocumentCollaborationPresenceReadParams): Promise<DocumentCollaborationPresenceSnapshot>;
}
