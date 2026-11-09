import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const ISessionFolderTrustRetryService = createServiceIdentifier<ISessionFolderTrustRetryService>('sessionFolderTrustRetryService');

interface SessionFolderTrustRetry {
	readonly path: string;
	run(): Promise<void>;
}

/** The title bar can retry a declined request while its project picker still owns the selection. */
export interface ISessionFolderTrustRetryService {
	readonly pending: IObservable<SessionFolderTrustRetry | undefined>;
	offer(retry: SessionFolderTrustRetry): IDisposable;
}

export class SessionFolderTrustRetryService implements ISessionFolderTrustRetryService {
	private readonly request = observableValue<SessionFolderTrustRetry | undefined>(this, undefined);
	readonly pending = this.request;

	offer(retry: SessionFolderTrustRetry): IDisposable {
		this.request.set(retry, undefined);
		return toDisposable(() => {
			if (this.request.get() === retry) this.request.set(undefined, undefined);
		});
	}
}
