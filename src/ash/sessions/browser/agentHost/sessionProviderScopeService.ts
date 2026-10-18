import { ILanguageModelToolsService } from '../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IAgentThreadService, IAgentVoiceService } from '../../../platform/agentHost/common/agentService.js';
import { IInstructionService } from '../../../platform/instructions/common/instructionService.js';
import { buildAgentHostSessionWorkspace } from '../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../common/sessionWorkspace.js';
import { createSessionVoiceService } from './sessionScopedVoiceService.js';
import { createSessionThreadService } from './sessionScopedThreadService.js';
import { Emitter } from '../../../base/common/event.js';
import { canceled } from '../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IRendererHostService, type IRendererHost } from '../../../platform/renderer/common/rendererHost.js';
import { IChatService } from '../../../workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import type { ISessionsProvider } from '../../services/sessions/common/sessionsProvider.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { SessionScopedPromptsService } from './sessionScopedPromptsService.js';
import { parseSessionIdentity, sessionIdentity } from '../../services/sessions/common/sessionIdentity.js';

/** Captured at host-scope composition, before the window installs its routing facades. */
export class SessionProviderServices {
	constructor(
		@IChatService readonly chat: IChatService,
		@ILanguageModelsService readonly models: ILanguageModelsService,
		@IPromptsService readonly prompts: IPromptsService,
		@IAgentExecutionSettingsService readonly execution: IAgentExecutionSettingsService,
		@IRendererHostService readonly host: IRendererHost,
		@ILanguageModelToolsService readonly tools: ILanguageModelToolsService,
	) { }
}
export const ISessionPrimaryProviderServices = createServiceIdentifier<SessionProviderServices>('sessionPrimaryProviderServices');

export interface ISessionProviderScope {
	readonly providerId: string;
	readonly services: SessionProviderServices;
	readonly thread: IAgentThreadService;
	identity(value: string): string;
	backendIdentity(value: string): string;
	assertCurrent(): void;
}

export interface ISessionProviderScopeService {
	readonly onDidChange: import('../../../base/common/event.js').Event<void>;
	readonly onDidChangeScopes: import('../../../base/common/event.js').Event<void>;
	getScopes(): readonly ISessionProviderScope[];
	createScope(sessionId?: string, providerId?: string): InstantiationService;
	getScope(sessionId?: string): ISessionProviderScope;
	getProviderScope(providerId: string): ISessionProviderScope;
}
export const ISessionProviderScopeService = createServiceIdentifier<ISessionProviderScopeService>('sessionProviderScopeService');

/** Owns service bindings only; the registry and host retain provider and connection ownership. */
export class SessionProviderScopeService extends Disposable implements ISessionProviderScopeService {
	private readonly bindings = new Map<ISessionsProvider, { scope: ISessionProviderScope; lifetime: DisposableStore; }>();
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly scopesChanged = this._register(new Emitter<void>());
	readonly onDidChangeScopes = this.scopesChanged.event;
	constructor(
		private readonly defaultProviderId: string,
		@ISessionPrimaryProviderServices private readonly primary: SessionProviderServices,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(management.onDidChange(() => this.changed.fire()));
		this._register(providers.onDidChangeProviders(({ removed }) => {
			for (const provider of removed) { this.bindings.get(provider)?.lifetime.dispose(); this.bindings.delete(provider); }
			this.scopesChanged.fire();
			this.changed.fire();
		}));
		this._register(toDisposable(() => { for (const binding of this.bindings.values()) binding.lifetime.dispose(); this.bindings.clear(); }));
	}
	createScope(sessionId?: string, providerId?: string): InstantiationService {
		const scope = providerId ? this.forProvider(providerId) : this.getScope(sessionId);
		scope.assertCurrent();
		const child = this.instantiation.createChild();
		child.registerInstance(IAgentThreadService, scope.thread);
		// An absent optional host port must mask the ambient window's voice service.
		child.registerInstance(IAgentVoiceService, createSessionVoiceService(scope));
		const instructions = scope.services.host.instructions;
		const workspace = this.providers.getProvider(scope.providerId)!.currentWorkspace();
		const resourceWorkspace = workspace.type === 'local' || workspace.type === 'ssh' || workspace.type === 'provider'
			? buildAgentHostSessionWorkspace(workspace) : undefined;
		child.registerInstance(IInstructionService, {
			get isAvailable() { try { scope.assertCurrent(); return instructions.isAvailable; } catch { return false; } },
			list: async sessionId => {
				scope.assertCurrent();
				const catalog = await instructions.list(sessionId === undefined ? undefined : scope.backendIdentity(sessionId));
				scope.assertCurrent();
				return catalog.map(instruction => ({ ...instruction, resource: instruction.resource ?? (resourceWorkspace ? sessionWorkspaceUri({ ...resourceWorkspace, root: instruction.path }) : undefined) }));
			},
		});
		child.registerInstance(ILanguageModelToolsService, scope.services.tools);
		child.registerInstance(ILanguageModelsService, scope.services.models);
		child.registerInstance(IAgentExecutionSettingsService, scope.services.execution);
		child.registerInstance(IPromptsService, new SessionScopedPromptsService(scope));
		return child;
	}
	getScopes(): readonly ISessionProviderScope[] {
		return this.providers.getProviders().filter(provider => provider.id === this.defaultProviderId || provider.instantiationService !== undefined).map(provider => this.forProvider(provider.id));
	}
	getScope(sessionId?: string): ISessionProviderScope {
		const providerId = sessionId !== undefined ? parseSessionIdentity(sessionId, this.defaultProviderId).providerId
			: this.management.activeUntitledSession?.providerId ?? this.management.active?.session.providerId ?? this.defaultProviderId;
		return this.forProvider(providerId);
	}
	getProviderScope(providerId: string): ISessionProviderScope { return this.forProvider(providerId); }
	private forProvider(providerId: string): ISessionProviderScope {
		const provider = this.providers.getProvider(providerId);
		if (!provider) throw canceled();
		const existing = this.bindings.get(provider);
		if (existing) return existing.scope;
		if (providerId !== this.defaultProviderId && !provider.instantiationService) throw canceled();
		const services = providerId === this.defaultProviderId ? this.primary : provider.instantiationService!.createInstance(SessionProviderServices);
		const lifetime = new DisposableStore();
		let thread: IAgentThreadService | undefined;
		const scope: ISessionProviderScope = {
			providerId, services,
			get thread() { return thread ??= createSessionThreadService(scope); },
			identity: value => sessionIdentity(providerId, value, this.defaultProviderId),
			backendIdentity: value => {
				const parsed = parseSessionIdentity(value, this.defaultProviderId);
				if (parsed.providerId !== providerId) throw canceled();
				return parsed.backendSessionId;
			},
			assertCurrent: () => { if (this.isDisposed || lifetime.isDisposed || this.providers.getProvider(providerId) !== provider) throw canceled(); },
		};
		this.bindings.set(provider, { scope, lifetime });
		return scope;
	}
}
