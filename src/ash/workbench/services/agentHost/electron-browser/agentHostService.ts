import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createAppServerExtensionHostApi } from '../../../../platform/agentHost/browser/extensionHostApi.js';
import {
	type AppServerConnectionRecovery,
	type AppServerProtocolClient,
} from '../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { RemoteAgentHostService } from '../../../../platform/agentHost/browser/remoteAgentHostServiceImpl.js';
import type { IExtensionHostApi } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { LOCAL_APP_SERVER_INITIALIZE_TIMEOUT_MS } from '../../../../platform/agentHost/common/appServerTransport.js';
import { LocalAgentHostServiceClient } from '../../../../platform/agentHost/electron-browser/localAgentHostService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { SSH_REMOTE_INITIALIZE_TIMEOUT_MS } from '../../../../platform/remote/common/remote.js';
import type { IAddress } from '../../../../platform/remote/common/remoteAgentConnection.js';
import type { RemoteAgentConnection } from '../../../../platform/remote/common/remoteAgentApi.js';
import { IRemoteSocketFactoryService } from '../../../../platform/remote/common/remoteSocketFactoryService.js';

interface WorkbenchAgentHostOptions {
	readonly connection: RemoteAgentConnection;
	readonly capabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean };
	readonly onDidSuspendOS: INativeHostApi['onDidSuspendOS'];
	readonly onDidResumeOS: INativeHostApi['onDidResumeOS'];
	readonly resolveRemoteAuthority?: (
		api: IExtensionHostApi,
		factories: IRemoteSocketFactoryService,
		authority: string,
		attempt: number,
	) => Promise<IAddress>;
	readonly initializeRemoteExtensions?: (api: IExtensionHostApi, authority: string) => Promise<IExtensionHostApi>;
}

/** Selects the Desktop window's execution host. Platform leases retain protocol and recovery ownership. */
export class WorkbenchAgentHostService extends Disposable {
	readonly localConnection: LocalAgentHostServiceClient;
	private selectedConnection: LocalAgentHostServiceClient | RemoteAgentHostService;
	private initialization: Promise<boolean> | undefined;
	private remoteExtensions: IExtensionHostApi | undefined;

	constructor(
		private readonly options: WorkbenchAgentHostOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRemoteSocketFactoryService private readonly factories: IRemoteSocketFactoryService,
	) {
		super();
		this.localConnection = this._register(
			instantiationService.createInstance(LocalAgentHostServiceClient, {
				clientName: 'ash-desktop',
				connection: options.connection.kind === 'ssh' ? 'local' : 'workspace',
				initializeTimeoutMs: LOCAL_APP_SERVER_INITIALIZE_TIMEOUT_MS,
				capabilities: { ...this.executionCapabilities(), directoryGrantsHost: { version: 1 } },
			}),
		);
		this.selectedConnection = this.localConnection;
		this.observePower(this.localConnection.recovery);
	}

	get connection(): LocalAgentHostServiceClient | RemoteAgentHostService {
		return this.selectedConnection;
	}
	get client(): AppServerProtocolClient {
		return this.selectedConnection.client;
	}
	get windowExtensions(): IExtensionHostApi | undefined {
		return this.remoteExtensions;
	}

	/** Disabled UI development hosts stay disconnected; a selected remote execution host must be ready. */
	connect(): Promise<boolean> {
		this.assertNotDisposed();
		return (this.initialization ??= this.initialize());
	}

	private async initialize(): Promise<boolean> {
		if (!(await this.localConnection.connect())) return false;
		this.assertNotDisposed();
		const remote = this.options.connection;
		if (remote.kind === 'ssh') {
			const workspace = this._register(
				this.instantiationService.createInstance(LocalAgentHostServiceClient, {
					clientName: 'ash-desktop-remote',
					initializeTimeoutMs: SSH_REMOTE_INITIALIZE_TIMEOUT_MS,
					capabilities: { ...this.executionCapabilities(), directoryGrantsHost: { version: 1 } },
				} satisfies ConstructorParameters<typeof LocalAgentHostServiceClient>[0]),
			);
			this.observePower(workspace.recovery);
			if (!(await workspace.connect()))
				throw new Error(
					localize(
						{ bundle: 'ash.workbench', key: 'agentHost.remoteWorkspaceUnavailable' },
						'The remote workspace App Server connection is unavailable.',
					),
				);
			this.assertNotDisposed();
			this.selectedConnection = workspace;
		} else if (remote.kind === 'remote') {
			const { resolveRemoteAuthority, initializeRemoteExtensions } = this.options;
			if (!resolveRemoteAuthority || !initializeRemoteExtensions)
				throw new Error(
					localize(
						{ bundle: 'ash.workbench', key: 'agentHost.remoteResolverUnavailable' },
						'This window does not provide a local Remote resolver.',
					),
				);
			const localExtensions = createAppServerExtensionHostApi(this.localConnection.client);
			let attempt = 0;
			const workspace = this._register(
				this.instantiationService.createInstance(RemoteAgentHostService, {
					protocol: {
						clientName: 'ash-desktop-remote',
						initializeTimeoutMs: 30_000,
						// Remote extension endpoints do not acquire the local host's grants or Desktop tools.
						capabilities: this.executionCapabilities(false),
					},
					getAddress: async () => {
						await this.localConnection.whenConnected();
						return resolveRemoteAuthority(localExtensions, this.factories, remote.authority, ++attempt);
					},
					getMetadata: () => this.localConnection.connectionMetadata,
					onDidReconnectLocal: this.localConnection.onDidReconnect,
					initialize: async (client: AppServerProtocolClient) => {
						const generation = client.generation;
						const extensions = await initializeRemoteExtensions(
							createAppServerExtensionHostApi(client),
							remote.authority,
						);
						if (client.generation !== generation || client.state !== 'ready') throw new CancellationError();
						this.remoteExtensions = extensions;
					},
				} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]),
			);
			this.observePower(workspace.recovery);
			await workspace.connect();
			this.assertNotDisposed();
			this.selectedConnection = workspace;
		}
		return true;
	}

	private executionCapabilities(desktopTools = true) {
		const capabilities = this.options.capabilities;
		return {
			agentInteractions: {
				version: 1 as const,
				kinds: ['approval', 'permissions', 'userInput'] as ('approval' | 'permissions' | 'userInput')[],
			},
			...(capabilities.browser ? { browser: { version: 4 as const, observe: true, input: true } } : {}),
			...(capabilities.textDocuments ? { textDocuments: { version: 2 as const } } : {}),
			...(desktopTools && capabilities.appTools
				? { appTools: { version: 1 as const, agents: true, desktop: true } }
				: {}),
		};
	}

	private observePower(recovery: AppServerConnectionRecovery): void {
		const suspend = this.options.onDidSuspendOS(() => recovery.suspend());
		const resume = this.options.onDidResumeOS(() => recovery.resume());
		this._register(
			toDisposable(() => {
				suspend.dispose();
				resume.dispose();
			}),
		);
	}
}
