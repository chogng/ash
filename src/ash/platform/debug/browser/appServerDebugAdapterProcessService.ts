import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { type IAppServerApi } from '../../agentHost/common/appServerApi.js';
import { type AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest, voidResult } from '../../agentHost/browser/appServerRequest.js';
import {
	type DebugSessionAdmission,
	type DebugSessionRelation,
	type DebugConsoleSnapshot,
	type DebugWorkspaceState,
	type DebugWorkspaceResult,
	type DebugWorkspaceEdit,
	type DebugBreakpointIntent,
	type DebugBreakpointsSnapshot,
	type DebugInspection,
	type DebugInspectionResult,
	type DebugSessionInitializeOptions,
	type IDebugAdapterProcessReadResult,
	type IDebugAdapterProcessService,
	type IDebugAdapterProcessStartOptions,
} from '../common/debugAdapterProcessService.js';
import { type RendererHostCapabilities } from '../../renderer/common/rendererHost.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';

/** App Server adapter for App Server-owned DAP processes. */
export class AppServerDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly sessions = new Map<string, { readonly sessionId: string; readonly dirId?: string }>();
	constructor(
		private readonly connection: AppServerProtocolClient,
		private readonly appServer: IAppServerApi,
	) {}

	readWorkspaceState(workspaceId: string, legacy?: DebugWorkspaceState): Promise<DebugWorkspaceResult> {
		return appServerRequest(this.connection, 'debug/workspace/read', {
			workspaceId,
			...(legacy === undefined ? {} : { legacy: workspaceState(legacy) }),
		});
	}
	editWorkspaceState(
		workspaceId: string,
		revision: number,
		edits: readonly DebugWorkspaceEdit[],
	): Promise<DebugWorkspaceResult> {
		return appServerRequest(this.connection, 'debug/workspace/write', {
			workspaceId,
			revision,
			edits: edits.map(edit =>
				edit.kind === 'remove'
					? { ...edit, ids: [...edit.ids] }
					: edit.kind === 'exceptions'
						? { ...edit, filters: [...edit.filters] }
						: edit.kind === 'data'
							? { ...edit, point: { ...edit.point, accessTypes: [...edit.point.accessTypes] } }
							: edit,
			),
		});
	}

	prepareSession(id: string, noDebug: boolean | undefined): Promise<DebugSessionRelation> {
		return appServerRequest(this.connection, 'debug/session/prepare', { id, noDebug: noDebug ?? null });
	}
	reserveSession(options: DebugSessionAdmission): Promise<DebugSessionRelation> {
		return appServerRequest(this.connection, 'debug/session/reserve', options);
	}
	manageSession(id: string, action: 'read' | 'route' | 'end'): Promise<DebugSessionRelation> {
		return appServerRequest(this.connection, 'debug/session/lifecycle', { id, action });
	}
	readConsole(
		id: string,
		options?: { readonly clear?: boolean; readonly diagnostic?: string },
	): Promise<DebugConsoleSnapshot> {
		return appServerRequest(this.connection, 'debug/session/console', {
			id,
			clear: options?.clear ?? false,
			...(options?.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
		});
	}

	async start(options: IDebugAdapterProcessStartOptions): Promise<string> {
		const sessionId = (
			await appServerRequest(this.connection, 'debug/adapter/start', {
				...options,
				arguments: [...options.arguments],
			})
		).sessionId;
		// Backend IDs are folder-scoped; callers need a handle unique across all folders.
		const handle = generateUuid();
		this.sessions.set(handle, { sessionId, ...(options.dirId === undefined ? {} : { dirId: options.dirId }) });
		return handle;
	}

	async send(sessionId: string, message: unknown): Promise<void> {
		await voidResult(
			appServerRequest(this.connection, 'debug/adapter/send', { ...this.session(sessionId), message }),
		);
	}

	async initializeSession(sessionId: string, options: DebugSessionInitializeOptions): Promise<void> {
		await voidResult(
			appServerRequest(this.connection, 'debug/session/initialize', {
				...this.session(sessionId),
				...options,
				arguments: { ...options.arguments },
			}),
		);
	}

	async completeConfiguration(sessionId: string, exceptionFilters: readonly string[] | undefined): Promise<void> {
		await voidResult(
			appServerRequest(this.connection, 'debug/session/configure', {
				...this.session(sessionId),
				...(exceptionFilters === undefined ? {} : { exceptionFilters: [...exceptionFilters] }),
			}),
		);
	}

	async setExceptionBreakpoints(sessionId: string, filters: readonly string[]): Promise<number> {
		return (
			await appServerRequest(this.connection, 'debug/session/exceptions/set', {
				...this.session(sessionId),
				exceptionFilters: [...filters],
			})
		).version;
	}

	async setBreakpoints(sessionId: string, version: number, intents: readonly DebugBreakpointIntent[]): Promise<void> {
		await voidResult(
			appServerRequest(this.connection, 'debug/session/breakpoints/set', {
				...this.session(sessionId),
				version,
				intents: [...intents],
			}),
		);
	}
	readBreakpoints(sessionId: string): Promise<DebugBreakpointsSnapshot> {
		return appServerRequest(this.connection, 'debug/session/breakpoints/read', this.session(sessionId));
	}
	async startInspection(
		sessionId: string,
		query: DebugInspection,
		inspectionRevision: number,
	): Promise<number | undefined> {
		const result = await appServerRequest(this.connection, 'debug/session/inspection/start', {
			...this.session(sessionId),
			inspectionRevision,
			query: query.kind === 'watch' ? { ...query, expressions: [...query.expressions] } : query,
		});
		return result.state === 'started' ? result.inspectionId : undefined;
	}

	readInspection(sessionId: string, inspectionId: number): Promise<DebugInspectionResult> {
		return appServerRequest(this.connection, 'debug/session/inspection/read', {
			...this.session(sessionId),
			inspectionId,
		});
	}

	async startRequest(sessionId: string, command: string, args?: unknown): Promise<number> {
		return (
			await appServerRequest(this.connection, 'debug/session/request', {
				...this.session(sessionId),
				command,
				...(args === undefined ? {} : { arguments: args }),
			})
		).requestId;
	}

	readResponse(sessionId: string, requestId: number) {
		return appServerRequest(this.connection, 'debug/session/response', { ...this.session(sessionId), requestId });
	}

	async acceptInput(sessionId: string, input: IDebugAdapterProcessReadResult): Promise<void> {
		await voidResult(
			appServerRequest(this.connection, 'debug/session/input', {
				...this.session(sessionId),
				messages: input.messages.map(entry => entry.message),
				outputGap: input.outputGap,
				stderr: input.stderr,
				exited: input.exited,
				exitCode: input.exitCode,
				protocolError: input.protocolError,
			}),
		);
	}

	async read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		return appServerRequest(this.connection, 'debug/adapter/read', {
			...this.session(sessionId),
			afterSequence,
			maxMessages,
		});
	}

	async close(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		this.sessions.delete(sessionId);
		await voidResult(appServerRequest(this.connection, 'debug/adapter/close', session));
	}

	private session(sessionId: string): { readonly sessionId: string; readonly dirId?: string } {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(
				localize('debug.adapterSessionUnavailable', 'The debug adapter session is no longer available.'),
			);
		}
		return session;
	}

	getConnectionState() {
		return this.appServer.getConnectionState();
	}

	onConnectionState(listener: Parameters<IAppServerApi['onConnectionState']>[0]): IDisposable {
		const subscription = this.appServer.onConnectionState(listener);
		return toDisposable(() => subscription.dispose());
	}
}

/** Code product contribution for the connected Vite renderer host. */
export function createAppServerDebugAdapterCapability(
	connection: AppServerProtocolClient,
	appServer: IAppServerApi,
): RendererHostCapabilities {
	return { debugAdapter: new AppServerDebugAdapterProcessService(connection, appServer) };
}

function workspaceState(state: DebugWorkspaceState) {
	return {
		breakpoints: [...state.breakpoints],
		functionBreakpoints: [...state.functionBreakpoints],
		dataBreakpoints: state.dataBreakpoints.map(point => ({ ...point, accessTypes: [...point.accessTypes] })),
		watchExpressions: [...state.watchExpressions],
		exceptionBreakpoints: Object.fromEntries(
			Object.entries(state.exceptionBreakpoints).map(([type, filters]) => [type, [...filters]]),
		),
	};
}
