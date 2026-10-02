import type { Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest, voidResult } from '../../app-server/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import type { ITestExecutionService, TestSnapshot, TestUpdate } from '../common/testExecutionService.js';

/** Converts the generated protocol at the boundary of the shared testing contract. */
export class AppServerTestExecutionService implements ITestExecutionService {
	public readonly onDidUpdate: Event<TestUpdate>;
	public readonly onDidDisconnect: Event<void>;

	constructor(private readonly connection: AppServerProtocolClient) {
		this.onDidUpdate = listener => connection.onNotification(notification => {
			if (notification.method === 'testing/updated') {
				listener({ ...notification.params, tests: notification.params.tests?.map(test => ({ ...test })) ?? null, result: notification.params.result ? { ...notification.params.result } : null });
			}
		});
		this.onDidDisconnect = listener => connection.onStateChange(state => {
			if (state === 'stopped' || state === 'crashed') { listener(); }
		});
	}

	public discover(operationId: string, dirId: string): Promise<void> {
		return this.request(voidResult(appServerRequest(this.connection, 'testing/discover', { operationId, dirId })));
	}

	public run(operationId: string, dirId: string, catalogId: string, testIds: readonly string[]): Promise<void> {
		return this.request(voidResult(appServerRequest(this.connection, 'testing/run', { operationId, dirId, catalogId, testIds: [...testIds] })));
	}

	public read(operationId: string): Promise<TestSnapshot> {
		return this.request(appServerRequest(this.connection, 'testing/read', { operationId }));
	}

	public cancel(operationId: string): Promise<TestSnapshot> {
		return this.request(appServerRequest(this.connection, 'testing/cancel', { operationId }));
	}

	public release(operationId: string): Promise<void> {
		return this.request(voidResult(appServerRequest(this.connection, 'testing/release', { operationId })));
	}

	private async request<T>(request: Promise<T>): Promise<T> {
		try { return await request; }
		catch (error) {
			if (error instanceof AppServerRemoteError) {
				throw new Error(localize('testing.backendError', 'Could not complete the test operation ({0}).', error.errorName), { cause: error });
			}
			throw error;
		}
	}
}
