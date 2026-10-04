import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { CDPEvent, CDPRequest, CDPResponse } from './cdp/types.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const IBrowserViewGroupService = createServiceIdentifier<IBrowserViewGroupService>('browserViewGroupService');

export interface IBrowserViewGroup extends IDisposable {
	readonly id: string;
	readonly onDidDestroy: Event<void>;
	readonly onCDPMessage: Event<CDPResponse | CDPEvent>;
	sendCDPMessage(message: CDPRequest): Promise<void>;
}

export interface IBrowserViewGroupFilter {
	/** Storage and ownership must both match; explicit IDs never grant access to another Thread. */
	readonly sandboxSessionId: string;
	readonly browserIds?: readonly string[];
}

export interface IBrowserViewGroupService {
	createGroup(filter: IBrowserViewGroupFilter): Promise<string>;
	/** Detaches the automation connection; Main retains the pages. */
	destroyGroup(groupId: string): Promise<void>;
	onDynamicDidDestroy(groupId: string): Event<void>;
	onDynamicCDPMessage(groupId: string): Event<CDPResponse | CDPEvent>;
	sendCDPMessage(groupId: string, message: CDPRequest): Promise<void>;
}
