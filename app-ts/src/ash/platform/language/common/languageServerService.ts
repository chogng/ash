import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface LanguageServerConfiguration {
	readonly mode: 'enabled' | 'disabled';
	readonly executable?: string;
}

export interface LanguageServerSnapshot {
	readonly revision: number;
	readonly configurations: Readonly<Record<string, LanguageServerConfiguration>>;
	readonly servers: readonly { readonly id: string; readonly languageIds: readonly string[] }[];
}

export interface ILanguageServerService {
	read(dirId?: string): Promise<LanguageServerSnapshot>;
	configure(serverId: string, configuration: LanguageServerConfiguration, expectedRevision: number): Promise<void>;
	removeConfiguration(serverId: string, expectedRevision: number): Promise<void>;
}

export const ILanguageServerService = createServiceIdentifier<ILanguageServerService>('languageServerService');
export const OPEN_LANGUAGE_SERVERS_COMMAND_ID = 'ash.languageServers.open';
