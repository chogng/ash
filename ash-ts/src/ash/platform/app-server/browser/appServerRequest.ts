import { APP_SERVER_METHODS, type AppServerMethod, type MethodParams, type MethodResult } from "../common/generated/index.js";
import type { AppServerProtocolClient } from "./appServerProtocolClient.js";

export function appServerRequest<M extends AppServerMethod>(connection: AppServerProtocolClient, method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
	return connection.request(APP_SERVER_METHODS[method], params);
}

export function voidResult<T>(promise: Promise<T>): Promise<void> {
	return promise.then(() => undefined);
}
