import type { IExtensionHostApi, JsonValue } from '../common/extensionHostApi.js';
import {
	invokeExtensionHost,
	normalizeExtensionHostChanged,
	normalizeExtensionHostSnapshot,
	normalizeExtensionHostPayload,
	normalizeExtensionStatusBarUpdate,
} from './extensionHostProtocol.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { AppServerProtocolClient } from './appServerProtocolClient.js';
import { appServerRequest } from './appServerRequest.js';
import { APP_SERVER_SERVER_REQUESTS } from '../../../../../.build/protocol/typescript/index.js';
import type { JsonValue as ProtocolJsonValue } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerServerRequestResult } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { inertSubscription } from '../../renderer/browser/disconnectedHost.js';

export function createDisconnectedExtensionHostApi(unavailable: UnavailableOperation): IExtensionHostApi {
	return {
		registerClientHandler: () => inertSubscription(),
		start: () => unavailable('extensionHost.start'),
		isAvailable: () => Promise.resolve(false),
		list: () => unavailable('extensionHost.list'),
		reconcile: () => unavailable('extensionHost.reconcile'),
		activateByEvent: () => unavailable('extensionHost.activate'),
		invoke: () => unavailable('extensionHost.invoke'),
		getConnectionState: () => Promise.resolve('stopped'),
		onDidChange: inertSubscription,
		onConnectionState: inertSubscription,
	};
}

export function createAppServerExtensionHostApi(connection: AppServerProtocolClient): IExtensionHostApi {
	const transport = {
		onDidComplete: (listener: (id: string) => void) =>
			connection.onNotification(event => {
				if (event.method === 'extensionHost/invoke/completed') listener(event.params.invocationId);
			}),
		onDidDisconnect: (listener: (error: Error) => void) =>
			connection.onStateChange((state, error) => {
				if (state !== 'ready') listener(error ?? new Error(`App Server is not ready: ${state}`));
			}),
		start: (request: Parameters<IExtensionHostApi['invoke']>[0]) =>
			appServerRequest(connection, 'extensionHost/invoke/start', request),
		read: (invocationId: string) => appServerRequest(connection, 'extensionHost/invoke/read', { invocationId }),
		cancel: (invocationId: string, resultRetention: 'retain' | 'discard') =>
			appServerRequest(connection, 'extensionHost/invoke/cancel', {
				invocationId,
				discardResult: resultRetention === 'discard',
			}),
	};
	return {
		registerClientHandler: handler =>
			connection.registerRequestHandler(
				APP_SERVER_SERVER_REQUESTS['extensionClient/request'],
				async ({ operation, ...source }, context) => {
					if (operation.operation === 'readWorkspaceFile') {
						throw new Error('Workspace file requests must be handled by App Server');
					}
					const request =
						operation.operation === 'addDebugBreakpoints'
							? { ...operation, breakpoints: operation.breakpoints.map(normalizeExtensionHostPayload) }
							: operation.operation === 'startDebugging'
								? {
										...operation,
										configuration: normalizeExtensionHostPayload(operation.configuration),
									}
								: operation.operation === 'debugCustomRequest'
									? { ...operation, arguments: normalizeExtensionHostPayload(operation.arguments) }
									: operation.operation === 'setStatusBarEntries'
										? normalizeExtensionStatusBarUpdate(operation)
										: operation.operation === 'executeCommand'
											? {
													...operation,
													arguments: operation.arguments.map(normalizeExtensionHostPayload),
												}
											: operation.operation === 'executeTask'
												? {
														...operation,
														task:
															operation.task === null
																? null
																: normalizeExtensionHostPayload(operation.task),
													}
												: operation.operation === 'updateConfiguration'
													? {
															...operation,
															value: normalizeExtensionHostPayload(operation.value),
														}
													: operation;
					const value = await handler(request, context.signal, source);
					// These operations use the protocol's generic JSON result in both Rust and browser hosts.
					if (
						value &&
						typeof value === 'object' &&
						'result' in value &&
						value.result === 'value' &&
						![
							'editorOperation',
							'backendRequest',
							'backendState',
							'createTerminal',
							'readTerminal',
						].includes(operation.operation)
					) {
						throw new TypeError(
							'Browser extension results cannot be returned over the App Server protocol',
						);
					}
					let response = value;
					if (
						value &&
						typeof value === 'object' &&
						'result' in value &&
						value.result === 'command' &&
						!('hasValue' in value)
					) {
						response = { ...value, hasValue: true };
					}
					const result = decodeAppServerServerRequestResult('extensionClient/request', response);
					// Domain payloads are immutable; the transport owns a separate mutable wire value.
					switch (result.result) {
						case 'value':
							return { ...result, value: protocolJsonValue(normalizeExtensionHostPayload(result.value)) };
						case 'resourceFile':
							return { ...result, bytes: [...result.bytes] };
						case 'resourceDirectory':
							return {
								...result,
								entries: result.entries.map(([name, type]) => [name, type] as [string, number]),
							};
						case 'initialization':
							return {
								result: result.result,
								initialization: {
									...result.initialization,
									workspaceFolders: result.initialization.workspaceFolders.map(folder => ({
										...folder,
									})),
									configurationValues: protocolJsonValue(
										normalizeExtensionHostPayload(result.initialization.configurationValues),
									),
									configurationData: protocolJsonValue(
										normalizeExtensionHostPayload(result.initialization.configurationData),
									),
								},
							};
						case 'debugSessions':
							return {
								...result,
								sessions: result.sessions.map(protocolJsonValue),
								breakpoints: result.breakpoints.map(protocolJsonValue),
							};
						case 'debugResponse':
							return { ...result, value: protocolJsonValue(result.value) };
						case 'tasks':
							return {
								...result,
								tasks: result.tasks.map(protocolJsonValue),
								executions: result.executions.map(protocolJsonValue),
							};
						case 'taskExecution':
							return { ...result, execution: protocolJsonValue(result.execution) };
						case 'command':
							return {
								...result,
								value: protocolJsonValue(result.value),
								hasValue: result.hasValue ?? true,
							};
						case 'configuration':
							return { ...result, value: protocolJsonValue(result.value) };
						default:
							return result;
					}
				},
			),
		start: async environment =>
			normalizeExtensionHostSnapshot(
				await appServerRequest(connection, 'extensionHost/start', { environment: { ...environment } }),
			),
		isAvailable: () => Promise.resolve(connection.capabilities?.extensionHost === true),
		list: async () => normalizeExtensionHostSnapshot(await appServerRequest(connection, 'extensionHost/list', {})),
		reconcile: async mode =>
			normalizeExtensionHostSnapshot(await appServerRequest(connection, 'extensionHost/reconcile', { mode })),
		activateByEvent: async request =>
			normalizeExtensionHostSnapshot(
				await appServerRequest(connection, 'extensionHost/activate', {
					...request,
					initialization: request.initialization
						? {
								...request.initialization,
								workspaceFolders: request.initialization.workspaceFolders.map(folder => ({
									...folder,
								})),
								configurationValues: protocolJsonValue(
									normalizeExtensionHostPayload(request.initialization.configurationValues),
								),
								configurationData: protocolJsonValue(
									normalizeExtensionHostPayload(request.initialization.configurationData),
								),
							}
						: undefined,
				}),
			),
		invoke: (request, signal) => invokeExtensionHost(transport, request, signal),
		getConnectionState: () => Promise.resolve(connection.state),
		onDidChange: listener =>
			connection.onNotification(event => {
				if (event.method === 'extensionHost/changed') listener(normalizeExtensionHostChanged(event.params));
			}),
		onConnectionState: listener => connection.onStateChange(listener),
	};
}

function protocolJsonValue(value: JsonValue): ProtocolJsonValue {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(protocolJsonValue);
	}
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, protocolJsonValue(entry)]));
}
