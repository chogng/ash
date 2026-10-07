import type { DocumentCollaborationOpenParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationOpenResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationPresenceParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationPresenceReadParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationPresenceSnapshot } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationSubmitParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { DocumentCollaborationSubmitResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";

/** Typed transport boundary for server-ordered structured-document collaboration. */
export interface IDocumentCollaborationApi {
	open(params: DocumentCollaborationOpenParams): Promise<DocumentCollaborationOpenResult>;
	submit(params: DocumentCollaborationSubmitParams): Promise<DocumentCollaborationSubmitResult>;
	publishPresence(params: DocumentCollaborationPresenceParams): Promise<DocumentCollaborationPresenceSnapshot>;
	readPresence(params: DocumentCollaborationPresenceReadParams): Promise<DocumentCollaborationPresenceSnapshot>;
}
