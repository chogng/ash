import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import type { ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { URI } from '../../../../../base/common/uri.js';

export interface ITerminalQuickFix {
	readonly label: string;
	readonly isValid?: () => boolean;
	readonly terminalCommand?: string;
	readonly shouldExecute?: boolean;
	readonly uri?: URI;
	readonly run?: () => Promise<void>;
}
export interface ITerminalQuickFixProvider {
	provideTerminalQuickFixes(
		instance: ITerminalInstance,
		command: ITerminalCommand,
		signal: AbortSignal,
	): Promise<readonly ITerminalQuickFix[]>;
}
export const ITerminalQuickFixService = createDecorator<ITerminalQuickFixService>('terminalQuickFixService');
export interface ITerminalQuickFixService {
	registerQuickFixProvider(id: string, provider: ITerminalQuickFixProvider): IDisposable;
	provideTerminalQuickFixes(
		instance: ITerminalInstance,
		command: ITerminalCommand,
		signal: AbortSignal,
	): Promise<readonly ITerminalQuickFix[]>;
}
