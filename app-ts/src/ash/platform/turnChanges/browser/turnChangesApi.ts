import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ITurnChangesApi } from "../common/turnChangesApi.js";

export function createDisconnectedTurnChangesApi(unavailable: UnavailableOperation): ITurnChangesApi {
	return {
		list: () => unavailable("turnChanges.list"),
		read: () => unavailable("turnChanges.read"),
		readFile: () => unavailable("turnChanges.readFile"),
		generateMessage: () => unavailable("turnChanges.generateMessage"),
		updateDraft: () => unavailable("turnChanges.updateDraft"),
		commit: () => unavailable("turnChanges.commit"),
		discardThread: () => unavailable("turnChanges.discardThread"),
	};
}

export function createAppServerTurnChangesApi(connection: AppServerProtocolClient): ITurnChangesApi {
	return {
		list: (params) => appServerRequest(connection, "turnChanges/list", params),
		read: (params) => appServerRequest(connection, "turnChanges/read", params),
		readFile: (params) => appServerRequest(connection, "turnChanges/readFile", params),
		generateMessage: (params) => appServerRequest(connection, "turnChanges/generateMessage", params),
		updateDraft: (params) => appServerRequest(connection, "turnChanges/updateDraft", params),
		commit: (params) => appServerRequest(connection, "turnChanges/commit", params),
		discardThread: (params) => appServerRequest(connection, "turnChanges/discardThread", params),
	};
}
