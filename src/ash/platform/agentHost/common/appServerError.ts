import type { AppServerErrorData, AppServerErrorName } from '../../../../../.build/protocol/typescript/index.js';
import { localize } from '../../../nls.js';

/** Transport-independent error returned by an App Server request. */
export class AppServerRemoteError extends Error {
	readonly errorName: AppServerErrorName;

	constructor(readonly code: number, message: string, readonly data: AppServerErrorData) {
		super(data.kind === 'ServerShuttingDown' ? localize('appServer.shuttingDown', 'App Server is stopping. Wait for it to finish, then reconnect.') : message);
		this.name = "AppServerRemoteError";
		this.errorName = data.kind;
	}
}
