import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalConfiguration } from '../common/terminal.js';

export interface ITerminalConfigurationService extends IDisposable {
	readonly config: Readonly<ITerminalConfiguration>;
	readonly onConfigChanged: Event<void>;
}

export const ITerminalConfigurationService = createServiceIdentifier<ITerminalConfigurationService>('terminalConfigurationService');
