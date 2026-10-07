import { Disposable } from "../../../../base/common/lifecycle.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import type { IExtensionService } from "../../../services/extensions/common/extensionService.js";
import type { IRemoteAgentService } from "../../../services/remote/common/remoteAgentService.js";

export interface RemoteExtensionRecoveryContributionOptions {
	readonly extensionService: IExtensionService;
	readonly remoteAgentService: IRemoteAgentService;
}

/** Refreshes backend-provided extension contributions after a remote reconnection. */
export class RemoteExtensionRecoveryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = "workbench.contrib.remoteExtensionRecovery";

	constructor(options: RemoteExtensionRecoveryContributionOptions) {
		super();
		let previousState = options.remoteAgentService.connectionState;
		this._register(options.remoteAgentService.onDidChangeConnectionState(state => {
			const previous = previousState;
			previousState = state;
			if (state !== "connected" || previous === undefined || previous === "connected") return;
			void options.extensionService.reload().catch(error => console.error("Declarative extension refresh after remote recovery failed", error));
		}));
	}
}
