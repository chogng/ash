import type { DisposableHandle } from "../../ipc/common/ipc.js";

export type UnavailableOperation = <T>(operation: string) => Promise<T>;

export class WebAppServerUnavailableError extends Error {
	constructor(readonly operation: string) {
		super(`Web App Server operation '${operation}' is unavailable because no Web host API was provided`);
		this.name = "WebAppServerUnavailableError";
	}
}

export const unavailableOperation: UnavailableOperation = <T>(operation: string): Promise<T> => Promise.reject(new WebAppServerUnavailableError(operation));

export function inertSubscription(): DisposableHandle {
	return { dispose(): void {} };
}
