import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface IExtensionIdentifier {
	readonly id: string;
}

/** Profile-wide editor enablement is separate from backend execution authorization. */
export interface IGlobalExtensionEnablementService {
	readonly onDidChangeEnablement: Event<{ readonly source?: string }>;
	getDisabledExtensions(): readonly IExtensionIdentifier[];
	enableExtension(extension: IExtensionIdentifier): Promise<boolean>;
	disableExtension(extension: IExtensionIdentifier): Promise<boolean>;
}

export const IGlobalExtensionEnablementService = createServiceIdentifier<IGlobalExtensionEnablementService>(
	'globalExtensionEnablementService',
);
