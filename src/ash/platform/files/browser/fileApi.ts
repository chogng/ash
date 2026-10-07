import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IFileApi } from "../common/fileApi.js";

export function createDisconnectedFileApi(unavailable: UnavailableOperation): IFileApi {
	return {
		getMetadata: () => unavailable("fs.getMetadata"),
		readDirectory: () => unavailable("fs.readDirectory"),
		readFile: () => unavailable("fs.readFile"),
		readBinaryFile: () => unavailable("fs.readBinaryFile"),
		writeFile: () => unavailable("fs.writeFile"),
		writeBinaryFile: () => unavailable("fs.writeBinaryFile"),
		createFile: () => unavailable("fs.createFile"),
		createDirectory: () => unavailable("fs.createDirectory"),
		copy: () => unavailable("fs.copy"),
		pasteSystemFiles: async () => false,
		rename: () => unavailable("fs.rename"),
		delete: () => unavailable("fs.delete"),
	};
}

export function createAppServerFileApi(connection: AppServerProtocolClient): IFileApi {
	return {
		getMetadata: (params) => appServerRequest(connection, "fs/getMetadata", params),
		readDirectory: (params) => appServerRequest(connection, "fs/readDirectory", params),
		readFile: (params) => appServerRequest(connection, "fs/readFile", params),
		readBinaryFile: (params) => appServerRequest(connection, "fs/readBinaryFile", params),
		writeFile: (params) => appServerRequest(connection, "fs/writeFile", params),
		writeBinaryFile: (params) => appServerRequest(connection, "fs/writeBinaryFile", params),
		createFile: (params) => appServerRequest(connection, "fs/createFile", params),
		createDirectory: (params) => appServerRequest(connection, "fs/createDirectory", params),
		copy: (params) => voidResult(appServerRequest(connection, "fs/copy", params)),
		pasteSystemFiles: (params) => appServerRequest(connection, "fs/pasteSystemFiles", params),
		rename: (params) => voidResult(appServerRequest(connection, "fs/rename", params)),
		delete: (params) => voidResult(appServerRequest(connection, "fs/delete", params)),
	};
}
