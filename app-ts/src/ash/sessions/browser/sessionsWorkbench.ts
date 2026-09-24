import "./media/sessionsWorkbench.css";
import "./actions/sessionsChatActions.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import type { IConfigurationApi } from "../../platform/configuration/common/configurationIpc.js";
import type { IKeybindingsResourceApi } from "../../platform/keybinding/common/keybindingsResource.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { IStorageService } from "../../platform/storage/common/storage.js";
import type { WorkbenchContextMenuServiceFactory } from "../../workbench/browser/workbenchInteractionServices.js";
import { BrowserStorageService } from "../../workbench/services/storage/browser/storageService.js";
import { WorkbenchConfigurationService } from "../../workbench/services/configuration/browser/configurationService.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import type { ISessionsWindowApi } from "../common/sessionsWindow.js";
import { CodeSessionsWorkbench, type CodeSessionsWorkbenchOptions } from "./code/codeSessionsWorkbench.js";
import { SessionsRuntime } from "./common/sessionsRuntime.js";
import { bindSessionsTheme } from "./common/sessionsTheme.js";

export interface SessionsWorkbenchOptions {
	readonly modeId: WorkbenchModeId;
	readonly profile: SessionsProfile;
	readonly api: IRendererHost;
	readonly sessionsWindowApi?: ISessionsWindowApi;
	readonly configurationApi?: IConfigurationApi;
	readonly keybindingsResourceApi?: IKeybindingsResourceApi;
	readonly createContextMenuService: WorkbenchContextMenuServiceFactory;
	readonly container: HTMLElement;
}

/** Standalone mode-owned Sessions host that intentionally does not construct WorkbenchLayout. */
export class SessionsWorkbench extends Disposable {
	readonly domNode: HTMLElement;

	constructor(options: SessionsWorkbenchOptions) {
		super();
		if (options.profile.modeId !== options.modeId) {
			throw new TypeError(`Sessions profile '${options.profile.id}' belongs to '${options.profile.modeId}', not '${options.modeId}'`);
		}
		const mode = WorkbenchModeRegistry.get(options.modeId);
		const container = options.container;
		const ownerWindow = container.ownerDocument.defaultView;
		if (!ownerWindow) throw new Error("Sessions renderer requires an owner window");
		this._register(bindSessionsTheme(container));
		const configurationService = this._register(new WorkbenchConfigurationService({ api: options.configurationApi }));
		const runtime = this._register(new SessionsRuntime(options.api, {
			configurationService,
		}));
		const storage = this._register(new BrowserStorageService({
			ownerWindow,
			applicationId: mode.storageNamespace,
			workspaceId: "sessions",
			profileId: options.profile.id,
		}));
		runtime.container.registerInstance(IStorageService, storage);
		container.replaceChildren();
		const sessions = this.createCodeSessions(container, {
			profile: options.profile,
			runtime,
			sessionsWindowApi: options.sessionsWindowApi,
			configurationService,
			keybindingsResourceApi: options.keybindingsResourceApi,
			createContextMenuService: options.createContextMenuService,
			storageService: storage,
		});
		this.domNode = sessions.domNode;
		sessions.layout();
	}

	private createCodeSessions(container: HTMLElement, options: CodeSessionsWorkbenchOptions): CodeSessionsWorkbench {
		if (options.profile.id !== "code-sessions") {
			throw new TypeError(`Unsupported Code Sessions profile '${options.profile.id}'`);
		}
		return this._register(new CodeSessionsWorkbench(container, options));
	}
}

/** Creates one dedicated Sessions workbench from the selected mode entry. */
export function startSessionsWorkbench(options: SessionsWorkbenchOptions): SessionsWorkbench {
	return new SessionsWorkbench(options);
}
