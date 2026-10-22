import type { JsonValue } from "../../../base/common/jsonValue.js";
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface LanguageServerConfiguration {
	readonly mode: 'enabled' | 'disabled';
	readonly executable?: string;
	readonly languageIds?: readonly string[];
	readonly args?: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
	readonly initializationOptions?: JsonValue;
	readonly settings?: Readonly<Record<string, JsonValue>>;
}

/** Connection-local process state; discovery alone never starts a server. */
export type LanguageServerState =
	| { readonly type: 'starting' | 'ready' | 'stopped'; }
	| { readonly type: 'backingOff'; readonly attempt: number; readonly retryAfterMillis: number; }
	| { readonly type: 'crashLoop'; readonly restartAttempts: number; readonly message: string; }
	| { readonly type: 'failed'; readonly message: string; };

export interface LanguageServerControl {
	readonly action: 'restart' | 'stop';
	readonly dirId?: string;
	/** Omit to control only the servers already started in this directory. */
	readonly serverId?: string;
}

export interface LanguageServerSnapshot {
	readonly revision: number;
	readonly configurations: Readonly<Record<string, LanguageServerConfiguration>>;
	readonly servers: readonly { readonly id: string; readonly languageIds: readonly string[]; readonly state?: LanguageServerState; }[];
}

export interface ILanguageServerService {
	read(dirId?: string): Promise<LanguageServerSnapshot>;
	control(request: LanguageServerControl): Promise<void>;
	configure(serverId: string, configuration: LanguageServerConfiguration, expectedRevision: number): Promise<void>;
	removeConfiguration(serverId: string, expectedRevision: number): Promise<void>;
}

export const ILanguageServerService = createServiceIdentifier<ILanguageServerService>('languageServerService');
export const OPEN_LANGUAGE_SERVERS_COMMAND_ID = 'ash.languageServers.open';
