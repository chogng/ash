import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const ITrustedDomainService = createServiceIdentifier<ITrustedDomainService>('ITrustedDomainService');

export interface ITrustedDomainService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTrustedDomains: Event<void>;
	readonly trustedDomains: readonly string[];
	isValid(resource: URI): boolean;
	/** The editable JSONC document is the sole persisted representation. */
	readonly content: string;
	setTrustedDomains(content: string, expectedContent?: string): Promise<void>;
}
