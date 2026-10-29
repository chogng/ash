import { Emitter, Event } from '../../../base/common/event.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import type { BrowserConnectorHostServices } from '../../connectors/browser/connectorApi.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { McpOAuthClientRequiredError } from '../common/mcpServerManagementService.js';
import type { IMcpServerManagementService, McpServerConfiguration, McpServerConfigurationSnapshot, McpOAuthLoginOptions } from '../common/mcpServerManagementService.js';

/** Converts the existing stable protocol without retaining a second configuration or runtime catalog. */
export class AppServerMcpServerManagementService extends Disposable implements IMcpServerManagementService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly activeCallbacks = new Set<() => void>();

	constructor(
		private readonly connection: AppServerProtocolClient,
		private readonly host?: BrowserConnectorHostServices,
	) {
		super();
		this._register(
			toDisposable(() => {
				for (const close of this.activeCallbacks) {
					close();
				}
				this.activeCallbacks.clear();
			}),
		);
		this._register(
			connection.onNotification(event => {
				if (event.method === 'config/changed') {
					this.changed.fire();
				}
			}),
		);
		this._register(connection.onStateChange(() => this.changed.fire()));
	}

	get isOAuthAvailable(): boolean {
		return this.connection.capabilities?.mcpOAuth === true && !!this.host?.callbackHost;
	}

	async login(serverId: string, options: McpOAuthLoginOptions = {}, signal?: AbortSignal): Promise<void> {
		const callbacks = this.host?.callbackHost;
		if (!this.isOAuthAvailable || !callbacks || !this.host) {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthUnavailable' }, 'MCP sign-in is unavailable in this window.'));
		}
		if (signal?.aborted) {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthCancelled' }, 'MCP sign-in was cancelled.'));
		}
		const server = (await this.readConfiguration()).servers.find(server => server.id === serverId);
		if (server?.transport.type !== 'streamableHttp') {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthHttpOnly' }, 'MCP sign-in requires an HTTPS server.'));
		}
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(server.transport.url).href));
		const callbackId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
		const callback = await callbacks.listen({ path: `/mcp-oauth/${callbackId}/callback` });
		let flowId: string | undefined;
		let completed = false;
		let cancellationRequest: Promise<unknown> | undefined;
		const cancel = () => {
			if (flowId && !completed) {
				cancellationRequest ??= appServerRequest(this.connection, 'mcp/oauth/cancel', { flowId }).catch(() => undefined);
			}
		};
		const close = () => {
			void callbacks.close(callback.id).catch(() => undefined);
			cancel();
		};
		signal?.addEventListener('abort', close, { once: true });
		const stateListener = this.connection.onStateChange(() => {
			if (this.connection.state !== 'ready') {
				close();
			}
		});
		this.activeCallbacks.add(close);
		try {
			if (signal?.aborted || this.isDisposed) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthCancelled' }, 'MCP sign-in was cancelled.'));
			}
			const started = await appServerRequest(this.connection, 'mcp/oauth/start', {
				serverId,
				redirectUri: callback.redirectUri,
				clientId: options.clientId,
				clientMetadataUrl: options.clientMetadataUrl,
				scopes: [...(options.scopes ?? [])],
			});
			flowId = started.flowId;
			if (signal?.aborted || this.isDisposed) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthCancelled' }, 'MCP sign-in was cancelled.'));
			}
			const opened = await this.host.externalOpener.openExternal(started.authorizationUrl, { sourceUri: URI.parse(started.authorizationUrl) }, CancellationToken.None);
			if (!opened) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthBrowserFailed' }, 'Could not open the sign-in page.'));
			}
			const values = await callbacks.wait(callback.id);
			if (signal?.aborted || this.isDisposed) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthCancelled' }, 'MCP sign-in was cancelled.'));
			}
			await appServerRequest(this.connection, 'mcp/oauth/complete', {
				flowId,
				state: values.state,
				authorizationCode: values.code,
				issuer: values.issuer,
			});
			completed = true;
		} catch (error) {
			if (signal?.aborted || this.isDisposed) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthCancelled' }, 'MCP sign-in was cancelled.'));
			}
			throw explain(error);
		} finally {
			signal?.removeEventListener('abort', close);
			stateListener.dispose();
			this.activeCallbacks.delete(close);
			await callbacks.close(callback.id).catch(() => undefined);
			cancel();
			await cancellationRequest;
			this.changed.fire();
		}
	}

	async logout(serverId: string): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/oauth/logout', { serverId }));
	}

	get isAvailable(): boolean {
		return this.connection.capabilities?.mcp === true;
	}

	async readConfiguration(): Promise<McpServerConfigurationSnapshot> {
		this.requireAvailable();
		try {
			const config = await appServerRequest(this.connection, 'config/read', {});
			return {
				revision: config.revision,
				servers: Object.values(config.mcpServers).map(server => ({
					id: server.id,
					displayName: server.displayName,
					transport:
						server.transport.type === 'stdio'
							? { type: 'stdio', command: server.transport.command, args: [...server.transport.args] }
							: { type: 'streamableHttp', url: server.transport.url },
					credential: server.credential.type === 'reference' ? { type: 'reference', credentialRef: server.credential.credentialRef } : { type: 'unauthenticated' },
					enablement: server.enablement,
				})),
			};
		} catch (error) {
			throw explain(error);
		}
	}

	async save(server: McpServerConfiguration, expectedRevision: number): Promise<void> {
		await this.mutate(() =>
			appServerRequest(this.connection, 'mcp/server/upsert', {
				commandId: generateUuid(),
				expectedRevision,
				server: {
					id: server.id,
					displayName: server.displayName,
					enablement: server.enablement,
					transport:
						server.transport.type === 'stdio'
							? { type: 'stdio', command: server.transport.command, args: [...server.transport.args] }
							: { type: 'streamableHttp', url: server.transport.url },
					credential: { ...server.credential },
				},
			}),
		);
	}

	async remove(serverId: string, expectedRevision: number): Promise<void> {
		await this.mutate(() =>
			appServerRequest(this.connection, 'mcp/server/remove', {
				commandId: generateUuid(),
				expectedRevision,
				serverId,
			}),
		);
	}

	async setEnablement(serverId: string, enabled: boolean, expectedRevision: number): Promise<void> {
		await this.mutate(() =>
			appServerRequest(this.connection, 'mcp/server/enablement/set', {
				commandId: generateUuid(),
				expectedRevision,
				serverId,
				enablement: enabled ? 'enabled' : 'disabled',
			}),
		);
	}

	async connect(serverId: string): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/connect', { serverId }));
	}

	async disconnect(serverId: string): Promise<void> {
		await this.mutate(() => appServerRequest(this.connection, 'mcp/server/disconnect', { serverId }));
	}

	private requireAvailable(): void {
		if (!this.isAvailable) {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpManagementUnavailable' }, 'MCP server management is unavailable.'));
		}
	}

	private async mutate(operation: () => Promise<unknown>): Promise<void> {
		this.requireAvailable();
		try {
			await operation();
		} catch (error) {
			throw explain(error);
		} finally {
			this.changed.fire();
		}
	}
}

function explain(error: unknown): unknown {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'McpOAuthRegistrationRequired':
				return new McpOAuthClientRequiredError(
					localize({ bundle: 'ash.extensions', key: 'mcpOAuthClientRequired' }, 'This MCP server needs a registered OAuth client ID or a client metadata URL.'),
				);
			case 'McpOAuthUnavailable':
				return new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthUnavailable' }, 'MCP sign-in is unavailable in this window.'));
			case 'McpOAuthReauthenticationRequired':
				return new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthSignInRequired' }, 'This MCP server needs sign-in again.'));
			case 'McpOAuthExpired':
				return new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthExpired' }, 'MCP sign-in expired. Start sign-in again.'));
			case 'McpOAuthInvalidCallback':
			case 'McpOAuthOperationFailed':
				return new Error(localize({ bundle: 'ash.extensions', key: 'mcpOAuthFailed' }, 'MCP authentication failed. Sign in again or check the server OAuth configuration.'));
			case 'ConfigRevisionConflict':
				return new Error(
					localize({ bundle: 'ash.extensions', key: 'mcpConfigurationConflict' }, 'MCP configuration changed. Refresh and review the current configuration before trying again.'),
				);
			case 'McpServerNotFound':
				return new Error(localize({ bundle: 'ash.extensions', key: 'mcpConfigurationMissing' }, 'This MCP server is no longer configured.'));
			case 'InvalidParams':
				return new Error(
					localize({ bundle: 'ash.extensions', key: 'mcpConfigurationInvalid' }, 'The backend rejected this MCP server configuration. Check its ID, transport and credential reference.'),
				);
			case 'ConfigUnavailable':
			case 'McpRuntimeUnavailable':
				return new Error(localize({ bundle: 'ash.extensions', key: 'mcpManagementUnavailable' }, 'MCP server management is unavailable.'));
		}
	}
	return error;
}

export function createDisconnectedMcpServerManagementService(unavailable: UnavailableOperation): IMcpServerManagementService {
	return {
		isAvailable: false,
		isOAuthAvailable: false,
		login: () => unavailable('mcpServerManagement.login'),
		logout: () => unavailable('mcpServerManagement.logout'),
		onDidChange: Event.None,
		dispose: () => {},
		[Symbol.dispose]: () => {},
		readConfiguration: () => unavailable('mcpServerManagement.readConfiguration'),
		save: () => unavailable('mcpServerManagement.save'),
		remove: () => unavailable('mcpServerManagement.remove'),
		setEnablement: () => unavailable('mcpServerManagement.setEnablement'),
		connect: () => unavailable('mcpServerManagement.connect'),
		disconnect: () => unavailable('mcpServerManagement.disconnect'),
	};
}
