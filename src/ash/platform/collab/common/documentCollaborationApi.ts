import type { DocumentCollaborationOpenParams } from "../../../../../.build/protocol/typescript/index.js";
import type { DocumentCollaborationOpenResult } from "../../../../../.build/protocol/typescript/index.js";
import type { DocumentCollaborationPresenceParams } from "../../../../../.build/protocol/typescript/index.js";
import type { DocumentCollaborationPresenceReadParams } from "../../../../../.build/protocol/typescript/index.js";
import type { DocumentCollaborationPresenceSnapshot } from "../../../../../.build/protocol/typescript/index.js";
import type { DocumentCollaborationSubmitParams } from "../../../../../.build/protocol/typescript/index.js";
import type { DocumentCollaborationSubmitResult } from "../../../../../.build/protocol/typescript/index.js";

/** Typed transport boundary for server-ordered structured-document collaboration. */
export interface IDocumentCollaborationApi {
	open(params: DocumentCollaborationOpenParams): Promise<DocumentCollaborationOpenResult>;
	submit(params: DocumentCollaborationSubmitParams): Promise<DocumentCollaborationSubmitResult>;
	publishPresence(params: DocumentCollaborationPresenceParams): Promise<DocumentCollaborationPresenceSnapshot>;
	readPresence(params: DocumentCollaborationPresenceReadParams): Promise<DocumentCollaborationPresenceSnapshot>;
}
