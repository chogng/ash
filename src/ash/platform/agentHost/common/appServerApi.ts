import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { ServerNotification, SlashCommandDefinition } from "../../../../../.build/protocol/typescript/index.js";
import type { Event } from '../../../base/common/event.js';
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import type { OperatingSystem } from '../../../base/common/platform.js';

export type AppServerConnectionState = "stopped" | "starting" | "initializing" | "ready" | "stopping" | "crashed" | "restarting";

/** App Server connection lifecycle visible to a renderer host. */
export interface IAppServerApi {
	/** Changes when the protocol client starts a replacement connection. */
	readonly connectionGeneration: number;
	/** Initialized server process OS; absent before readiness and after connection closure. */
	readonly operatingSystem?: OperatingSystem;
	/** Absolute OS user directory of the initialized server; unrelated to ASH_HOME. */
	readonly userHome?: string;
	getConnectionState(): Promise<AppServerConnectionState>;
	getSlashCommands(): Promise<readonly SlashCommandDefinition[]>;
	onConnectionState(listener: (state: AppServerConnectionState) => void): DisposableHandle;
}

/** Connection-owned opaque resource operations. */
export interface IResourceApi {
	readonly connectionGeneration: number;
	metadata(params: ResourceMetadataParams): Promise<ResourceMetadataResult>;
	read(params: ResourceReadParams): Promise<ResourceReadResult>;
	release(params: ResourceReleaseParams): Promise<void>;
}

export interface ResourceMetadataParams { readonly resourceId: string; }
export interface ResourceMetadataResult extends ResourceMetadataParams {
	readonly mimeType: string;
	readonly size: number;
	readonly sha256: string;
}
export interface ResourceReadParams extends ResourceMetadataParams { readonly offset: number; readonly maxBytes: number; }
export interface ResourceReadResult extends ResourceMetadataParams {
	readonly offset: number;
	readonly dataBase64: string;
	readonly decodedLength: number;
	readonly eof: boolean;
}
export interface ResourceReleaseParams extends ResourceMetadataParams { }

/** Canonical App Server notification stream. */
export interface IServerEventApi {
	subscribe(listener: (event: ServerNotification) => void): DisposableHandle;
}

export const IAppServerApi = createServiceIdentifier<IAppServerApi>('AppServerApi');
export const IServerEventApi = createServiceIdentifier<IServerEventApi>('ServerEventApi');

export type SkillCatalogReload = 'cached' | 'refresh';

export interface SkillIdentity {
	readonly source: string;
	readonly name: string;
}

export interface SkillReference {
	readonly id: SkillIdentity;
	readonly version: { readonly type: 'pinnedDigest'; readonly digest: string; };
}

export interface SkillDescriptor {
	readonly id: SkillIdentity;
	readonly description: string;
	readonly contentDigest: string;
	readonly enabled: boolean;
	readonly compatible: boolean;
}

export interface SkillCatalog {
	readonly generation: number;
	readonly skills: readonly SkillDescriptor[];
}

export interface SkillManagementSnapshot {
	readonly revision: number;
	readonly catalog: SkillCatalog;
	readonly diagnostics: readonly { readonly source: string; readonly subject: string | undefined; readonly message: string; }[];
}

/** Mechanical backend access; Workbench Prompt service owns discovery and readable URIs. */
export interface IAppServerSkillApi {
	readonly onDidChangeSkills: Event<void>;
	list(reload: SkillCatalogReload, sessionId?: string): Promise<SkillCatalog>;
	read(sessionId?: string): Promise<SkillManagementSnapshot>;
	setEnabled(skillId: SkillIdentity, enabled: boolean, expectedRevision: number, sessionId?: string): Promise<void>;
	readInstructions(reference: SkillReference, signal: AbortSignal, sessionId?: string): Promise<string>;
}

export const IAppServerSkillApi = createServiceIdentifier<IAppServerSkillApi>('appServerSkillApi');
