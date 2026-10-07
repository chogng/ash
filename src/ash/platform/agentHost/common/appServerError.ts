import type { AppServerErrorData, AppServerErrorName } from '../../../../../.build/protocol/typescript/index.js';

/** Transport-independent error returned by an App Server request. */
export class AppServerRemoteError extends Error {
	readonly errorName: AppServerErrorName;

	constructor(readonly code: number, message: string, readonly data: AppServerErrorData) {
		super(message);
		this.name = "AppServerRemoteError";
		this.errorName = data.kind;
	}
}
