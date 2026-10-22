import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Window presentation of the backend-owned language server lifecycle. */
export interface ILanguageServerStatusService {
	open(): Promise<void>;
	getAccessibleContent(): string;
}

export const ILanguageServerStatusService = createServiceIdentifier<ILanguageServerStatusService>('languageServerStatusService');
export const MANAGE_LANGUAGE_SERVERS_COMMAND_ID = 'ash.languageServers.manage';
export const LanguageServerMenuFocused = new RawContextKey<boolean>('languageServerMenuFocused', false);

export const LANGUAGE_SERVER_STATUS_ENTRY_ID = 'ash.status.languageServers';
