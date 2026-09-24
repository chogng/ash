import type { IDocumentCollaborationApi } from "../common/documentCollaborationApi.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";

export function createDisconnectedDocumentCollaborationApi(unavailable: UnavailableOperation): IDocumentCollaborationApi {
	return {
		open: () => unavailable("documentCollaboration.open"),
		submit: () => unavailable("documentCollaboration.submit"),
		publishPresence: () => unavailable("documentCollaboration.publishPresence"),
		readPresence: () => unavailable("documentCollaboration.readPresence"),
	};
}

export function createAppServerDocumentCollaborationApi(connection: AppServerProtocolClient): IDocumentCollaborationApi {
	return {
		open: params => appServerRequest(connection, "document/collaboration/open", params),
		submit: params => appServerRequest(connection, "document/collaboration/submit", params),
		publishPresence: params => appServerRequest(connection, "document/collaboration/presence/publish", params),
		readPresence: params => appServerRequest(connection, "document/collaboration/presence/read", params),
	};
}
