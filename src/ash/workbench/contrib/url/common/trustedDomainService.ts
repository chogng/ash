import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const ITrustedDomainService = createServiceIdentifier<ITrustedDomainService>('ITrustedDomainService');

export interface ITrustedDomainService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTrustedDomains: Event<void>;
	/** Product and user rules applied by outgoing link protection. */
	readonly trustedDomains: readonly string[];
	readonly userTrustedDomains: readonly string[];
	isValid(resource: URI): boolean;
	/** The user JSONC document with the current product defaults rendered as comments. */
	readonly content: string;
	/** Returns the published document for the virtual file's revision. */
	setTrustedDomains(content: string, expectedContent?: string): Promise<string>;
	addTrustedDomain(pattern: string): Promise<void>;
	updateTrustedDomain(original: string, pattern: string): Promise<string>;
	removeTrustedDomain(pattern: string): Promise<void>;
}
