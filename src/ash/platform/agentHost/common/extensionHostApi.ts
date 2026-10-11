import type { IConfigurationData } from '../../configuration/common/configuration.js';
import type { LinkPresentationKind } from '../../dataChannel/common/dataChannel.js';
import type { AppServerConnectionState } from './appServerApi.js';
import type { DisposableHandle } from '../../ipc/common/ipc.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type ExtensionHostReconcileMode = "refresh" | "restartFailed";
export type ExtensionHostRuntimeLifecycle = "dormant" | "stopped" | "starting" | "handshaking" | "ready" | "recovering" | "crashLoop" | "failed";
export type ExtensionHostFailureCode = "authorityDenied" | "staleSnapshot" | "isolationUnavailable" | "launchFailed" | "handshakeFailed" | "activationFailed" | "registrationNotFound" | "operationNotSupported" | "cancelled" | "deadlineExceeded" | "quotaExceeded" | "hostExited" | "hostRestarted" | "outcomeIndeterminate" | "crashLoop" | "invalidProtocol" | "internal";
export type ExtensionHostLanguageProviderOperation = "diagnostics" | "selectionRanges" | "documentHighlights" | "workspaceSymbols" | "completion" | "definition" | "hover" | "references" | "rename" | "formatting" | "codeAction" | "codeLens" | "documentSymbols" | "foldingRanges" | "documentLinks" | "documentColors" | "semanticTokens" | "inlayHints" | "linkedEditing" | "parameterHints";
export type ExtensionHostCancellationReason = "caller" | "deadline" | "authorityRevoked" | "shutdown";
export type ExtensionHostOutputSeverity = "trace" | "debug" | "information" | "warning" | "error" | "log";
export type ExtensionHostOutputOperation =
	| { readonly operation: "create"; readonly channelId: string; readonly label: string; readonly kind: "output" | "log"; }
	| { readonly operation: "append" | "replace"; readonly channelId: string; readonly text: string; readonly severity: ExtensionHostOutputSeverity; readonly category: string | undefined; }
	| { readonly operation: "clear" | "dispose"; readonly channelId: string; }
	| { readonly operation: "show"; readonly channelId: string; readonly preserveFocus: boolean; };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue; };

export interface ExtensionHostRuntimeFailure {
	readonly code: ExtensionHostFailureCode;
	readonly message: string;
	readonly incarnation: number | undefined;
}

export interface ExtensionHostOutputEvent {
	readonly sequence: number;
	readonly incarnation: number;
	readonly activationGeneration: number;
	readonly operation: ExtensionHostOutputOperation;
}

interface ExtensionHostRegistrationBase {
	readonly registrationId: string;
}

/** Read-only window facts share the existing extension incarnation lifetime. */
export interface ExtensionHostWorkspaceEventsRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'workspaceEvents';
}

export interface ExtensionHostCommandRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "command";
	readonly command: string;
	readonly title: string;
	readonly icon?: string;
	readonly menus?: readonly { readonly menu: string; readonly when?: string; readonly group?: string; readonly alt?: string; }[];
}

/** Browser custom text providers render a shared document, without owning its persistence. */
export interface ExtensionHostCustomEditorRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'customTextEditor';
	readonly viewType: string;
	readonly displayName: string;
	readonly selectors: readonly string[];
	readonly languageIds?: readonly string[];
	readonly priority: 'default' | 'option';
}

export interface ExtensionHostLanguageRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "languageProvider";
	readonly languageIds: readonly string[];
	readonly operations: readonly ExtensionHostLanguageProviderOperation[];
	readonly completionTriggerCharacters?: readonly string[];
}

export interface ExtensionHostDocumentEventsRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'textDocumentEvents';
}

export interface ExtensionStatusBarEntry {
	readonly id: string;
	readonly text: string;
	readonly tooltip: string | null;
	readonly ariaLabel: string | null;
	readonly alignment: 'left' | 'right';
	readonly priority: number;
	readonly command: { readonly command: string; readonly arguments: readonly JsonValue[]; } | null;
}

export interface ExtensionHostStatusBarRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'statusBar';
	readonly revision: number;
	readonly entries: readonly ExtensionStatusBarEntry[];
}

export interface ExtensionHostDebugAdapterRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "debugAdapter";
	readonly debuggerType: string;
}

export interface ExtensionHostDebugConfigurationProviderRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'debugConfigurationProvider';
	readonly debuggerType: string;
	readonly triggerKind: 1 | 2;
}

export interface ExtensionHostTaskProviderRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "taskProvider";
	readonly taskType: string;
}

export interface ExtensionHostDebugAdapterTrackerRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'debugAdapterTracker';
	readonly debuggerType: string;
}

export interface ExtensionHostDebugEventsRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'debugEvents';
}

export interface ExtensionHostTaskEventsRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'taskEvents';
}

export interface ExtensionHostTestProfileProviderRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "testProfileProvider";
	readonly providerId: string;
	readonly label: string;
}

export interface ExtensionHostDataChannelRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'dataChannel';
	readonly channelId: string;
}

export interface ExtensionHostLinkPresentationRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'linkPresentationProvider';
	readonly uriPattern: string;
	readonly presentationKind: LinkPresentationKind;
}

export interface ExtensionHostExternalUriOpenerRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'externalUriOpener';
	readonly schemes: readonly ('http' | 'https')[];
	readonly label: string;
}

export interface ExtensionHostRemoteAuthorityResolverRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'remoteAuthorityResolver';
	readonly authorityPrefix: string;
}

export interface ExtensionHostRemoteConnectionResolverRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'remoteConnectionResolver';
	readonly authorityPrefix: string;
}

/** Browser SCM callbacks and snapshots share one activation fence. */
export interface ExtensionHostSCMRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'sourceControl';
	readonly revision: number;
	readonly providers: readonly JsonValue[];
}

export type ExtensionHostRegistration = ExtensionHostSCMRegistration | ExtensionHostRemoteConnectionResolverRegistration | ExtensionHostRemoteAuthorityResolverRegistration | ExtensionHostWorkspaceEventsRegistration | ExtensionHostStatusBarRegistration | ExtensionHostDocumentEventsRegistration | ExtensionHostCustomEditorRegistration | ExtensionHostExternalUriOpenerRegistration | ExtensionHostCommandRegistration | ExtensionHostLanguageRegistration | ExtensionHostDebugAdapterRegistration | ExtensionHostDebugConfigurationProviderRegistration | ExtensionHostDebugAdapterTrackerRegistration | ExtensionHostTaskProviderRegistration | ExtensionHostTaskEventsRegistration | ExtensionHostDebugEventsRegistration | ExtensionHostTestProfileProviderRegistration | ExtensionHostDataChannelRegistration | ExtensionHostLinkPresentationRegistration;

export type ExtensionHostActivationEvent = { readonly type: 'command'; readonly command: string; } | { readonly type: 'language'; readonly languageId: string; } | { readonly type: 'taskType'; readonly taskType: string | null; } | { readonly type: 'debug'; readonly phase: 'start' | 'initialConfigurations' | 'dynamicConfigurations' | 'resolveConfiguration'; readonly debugType: string | null; } | { readonly type: 'startupFinished'; } | { readonly type: 'resolveAuthority'; readonly authorityPrefix: string; };
export interface ExtensionHostInitialization {
	readonly language?: string;
	readonly workspaceFolders: readonly { readonly uri: string; readonly name: string; readonly index: number; }[];
	readonly workspaceName: string | null;
	readonly workspaceFile: string | null;
	readonly configurationValues: Readonly<Record<string, unknown>>;
	readonly configurationData: IConfigurationData | null;
}

export interface ExtensionHostActivationRequest {
	readonly initialization?: ExtensionHostInitialization;
	readonly extensionId: string;
	readonly activationGeneration: number;
	readonly event: ExtensionHostActivationEvent;
}
/** Manifest facts available while waiting; these are not process registrations. */
export interface ExtensionHostActivation {
	readonly events: readonly string[];
	readonly commands: readonly { readonly command: string; readonly title: string; }[];
}

export interface ExtensionHostRuntime {
	readonly id: string;
	readonly version: string;
	readonly packageDigest: string;
	readonly runtimeApiVersion: number;
	readonly activationGeneration: number;
	readonly incarnation: number | undefined;
	readonly lifecycle: ExtensionHostRuntimeLifecycle;
	readonly activation?: ExtensionHostActivation;
	readonly failure: ExtensionHostRuntimeFailure | undefined;
	readonly stderr: string;
	readonly outputEvents: readonly ExtensionHostOutputEvent[];
	readonly registrations: readonly ExtensionHostRegistration[];
}

export interface ExtensionHostFleetSnapshot {
	readonly generation: number;
	readonly extensions: readonly ExtensionHostRuntime[];
}

export interface ExtensionHostInvocationRequest {
	readonly extensionId: string;
	readonly registrationId: string;
	readonly activationGeneration: number;
	readonly incarnation: number;
	readonly operation: string;
	readonly payload: JsonValue;
	readonly deadlineUnixMillis: number;
}

/** Renderer-facing Extension Host authority and invocation capability. */
export interface IExtensionHostApi {
	registerClientHandler(handler: ExtensionHostClientHandler): DisposableHandle;
	isAvailable(): Promise<boolean>;
	/** Starts a connection-owned fleet before extension activation; values never alter the shared backend process. */
	start(environment: Readonly<Record<string, string | null>>): Promise<ExtensionHostFleetSnapshot>;
	list(): Promise<ExtensionHostFleetSnapshot>;
	reconcile(mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot>;
	/** Asks Rust to match editor intent against one exact authorized package generation. */
	activateByEvent(request: ExtensionHostActivationRequest): Promise<ExtensionHostFleetSnapshot>;
	invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue>;
	getConnectionState(): Promise<AppServerConnectionState>;
	onDidChange(listener: (generation: number) => void): DisposableHandle;
	onConnectionState(listener: (state: AppServerConnectionState) => void): DisposableHandle;
}

export interface ExtensionClientSource {
	readonly extensionId: string;
	readonly activationGeneration: number;
	readonly incarnation: number;
}

/** Host boundaries validate callback messages before forwarding them to the owning client adapter. */
export type ExtensionHostClientHandler = (operation: unknown, signal: AbortSignal, source: ExtensionClientSource) => Promise<unknown>;

export const IExtensionHostApi = createServiceIdentifier<IExtensionHostApi>("extensionHostApi");

export class ExtensionHostInvocationError extends Error {
	constructor(readonly code: ExtensionHostFailureCode, message: string) {
		super(message);
		this.name = "ExtensionHostInvocationError";
	}
}
