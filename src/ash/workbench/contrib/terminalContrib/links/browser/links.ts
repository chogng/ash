import type { Event } from '../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalExternalLinkProvider } from '../../../terminal/browser/terminal.js';

export const ITerminalLinkProviderService = createDecorator<ITerminalLinkProviderService>('terminalLinkProviderService');

/** Window-owned providers shared by existing and future terminal instances. */
export interface ITerminalLinkProviderService {
	readonly linkProviders: ReadonlySet<ITerminalExternalLinkProvider>;
	readonly onDidAddLinkProvider: Event<ITerminalExternalLinkProvider>;
	readonly onDidRemoveLinkProvider: Event<ITerminalExternalLinkProvider>;
	registerLinkProvider(provider: ITerminalExternalLinkProvider): IDisposable;
}
