import type { CancellationToken } from '../../base/common/cancellation.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import type { SessionExecutionTarget } from '../services/sessions/common/session.js';

/** Provisioning belongs to the shared backend's optional Docker Provider. */
export interface IDevContainerAgentHostService {
	readonly _serviceBrand: undefined;
	getTargets(token: CancellationToken): Promise<readonly SessionExecutionTarget[]>;
	isAvailable(workspace: string, token: CancellationToken): Promise<boolean>;
	connect(workspace: string, token: CancellationToken): Promise<SessionExecutionTarget>;
	stopContainer(workspace: string, token: CancellationToken): Promise<void>;
	removeContainer(workspace: string, token: CancellationToken): Promise<void>;
}
export const IDevContainerAgentHostService =
	createDecorator<IDevContainerAgentHostService>('devContainerAgentHostService');
