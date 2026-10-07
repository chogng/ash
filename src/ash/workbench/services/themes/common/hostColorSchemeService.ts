import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export interface IHostColorSchemeService {
	readonly dark: boolean;
	readonly highContrast: boolean;
	readonly onDidChangeColorScheme: Event<void>;
}

export const IHostColorSchemeService = createServiceIdentifier<IHostColorSchemeService>('hostColorSchemeService');
