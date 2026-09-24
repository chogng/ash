import { Disposable } from "../../../base/common/lifecycle.js";
import { ServiceContainer } from "../../../platform/instantiation/common/instantiation.js";
import type { IRendererHost } from "../../../platform/renderer/common/rendererHost.js";
import type { IConfigurationService } from "../../../platform/configuration/common/configuration.js";
import { ChatService } from "../../../workbench/services/chat/browser/chatService.js";
import { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import { AppServerSessionsManagementService } from "../../services/sessions/browser/appServerSessionsManagementService.js";
import { AppServerSessionsProvider } from "../../services/sessions/browser/appServerSessionsProvider.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagementService.js";
import { SessionsService } from "../../services/view/browser/sessionsService.js";
import { ISessionsService } from "../../services/view/common/sessionsService.js";

export interface SessionsRuntimeOptions {
	readonly configurationService?: IConfigurationService;
}

/** Shared App Server-backed state used by one dedicated Sessions renderer. */
export class SessionsRuntime extends Disposable {
	readonly container: ServiceContainer;
	readonly sessions: AppServerSessionsManagementService;
	readonly view: SessionsService;
	readonly chat: ChatService;

	constructor(api: IRendererHost, options: SessionsRuntimeOptions = {}) {
		super();
		this.container = this._register(new ServiceContainer());
		this.sessions = this._register(new AppServerSessionsManagementService(new AppServerSessionsProvider({ session: api.session, model: api.model, turn: api.turn, events: api.events })));
		this.view = this._register(new SessionsService(this.sessions));
		this.chat = this._register(new ChatService({
			modelApi: api.model,
			threadApi: api.thread,
			turnApi: api.turn,
			turnChangesApi: api.turnChanges,
			skillApi: api.skills,
			appServerApi: api.appServer,
			eventApi: api.events,
			...(options.configurationService ? { configurationService: options.configurationService } : {}),
		}));
		this.container.registerInstance(ISessionsManagementService, this.sessions);
		this.container.registerInstance(ISessionsService, this.view);
		this.container.registerInstance(IChatService, this.chat);
	}

	async initialize(): Promise<void> {
		await this.view.initialize();
		if (!this.view.activeSelection) this.view.openNewSession("New code session");
	}
}
