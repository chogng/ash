import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { DialogSeverity } from "../../../../platform/dialogs/common/dialogs.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { ContextKeyExpr } from "../../../../platform/contextkey/common/contextkey.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import type { IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../../../../platform/remote/common/remoteConnectionService.js";
import { IRemoteAgentService } from "../../../services/remote/common/remoteAgentService.js";
import { RemoteConnectionKindContext } from "./remoteContextKeys.js";
import { RemoteConnectionStateContext } from "./remoteContextKeys.js";
import { RemoteConnectionsAvailableContext } from "./remoteContextKeys.js";
import { showRemoteConnectionManager } from "./remoteConnectionManagement.js";

export const RollbackRemoteRuntimeCommandId = "workbench.action.remote.rollbackRuntime";
export const ReconnectRemoteCommandId = "workbench.action.remote.reconnect";
export const ConnectToRemoteCommandId = "workbench.action.remote.connect";
export const ManageRemoteConnectionsCommandId = "workbench.action.remote.manageConnections";

interface RemoteConnectionQuickPickItem extends IQuickPickItem {
	readonly connection: RemoteConnectionDefinition;
}

registerAction2(class ConnectToRemoteAction extends Action2 {
	constructor() {
		super({
			id: ConnectToRemoteCommandId,
			title: "Remote: Connect to Saved SSH Host",
			f1: true,
			precondition: RemoteConnectionsAvailableContext.isEqualTo(true),
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return showRemoteConnectionPicker(
			accessor.get(IRemoteConnectionService),
			accessor.get(IQuickInputService),
			accessor.get(IDialogService),
		);
	}
});

registerAction2(class RollbackRemoteRuntimeAction extends Action2 {
	constructor() {
		super({
			id: RollbackRemoteRuntimeCommandId,
			title: "Remote: Roll Back Remote Runtime",
			f1: true,
			precondition: RemoteConnectionKindContext.isEqualTo("ssh"),
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IRemoteAgentService).rollbackRuntime().then(() => undefined);
	}
});

registerAction2(class ReconnectRemoteAction extends Action2 {
	constructor() {
		super({
			id: ReconnectRemoteCommandId,
			title: "Remote: Reconnect to SSH Host",
			f1: true,
			precondition: ContextKeyExpr.and(RemoteConnectionKindContext.isEqualTo("ssh"), RemoteConnectionStateContext.isEqualTo("disconnected")),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		try {
			await accessor.get(IRemoteAgentService).reconnect();
		} catch (error) {
			await showConnectionError(accessor.get(IDialogService), "Could not reconnect to the Remote Workspace", error);
		}
	}
});

registerAction2(class ManageRemoteConnectionsAction extends Action2 {
	constructor() {
		super({
			id: ManageRemoteConnectionsCommandId,
			title: "Remote: Manage Saved SSH Hosts",
			f1: true,
			precondition: RemoteConnectionsAvailableContext.isEqualTo(true),
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return showRemoteConnectionManager(
			accessor.get(IRemoteConnectionService),
			accessor.get(IQuickInputService),
			accessor.get(IDialogService),
		);
	}
});

export async function showRemoteConnectionPicker(
	connections: IRemoteConnectionService,
	quickInput: IQuickInputService,
	dialogs: IDialogService,
): Promise<void> {
	let available: readonly RemoteConnectionDefinition[];
	try {
		available = await connections.list();
	} catch (error) {
		await showConnectionError(dialogs, "Could not load saved Remote connections", error);
		return;
	}
	if (available.length === 0) {
		await dialogs.showMessage({
			severity: DialogSeverity.Info,
			title: "No saved Remote connections",
			message: "Add a credential-free SSH target before connecting.",
			detail: "Run 'Remote: Manage Saved SSH Hosts' from the Command Palette.",
		});
		return;
	}

	const picker = quickInput.createQuickPick<RemoteConnectionQuickPickItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.placeholder = "Select a Remote SSH connection";
	picker.items = available.map(connection => ({
		connection,
		label: connection.name,
		description: connection.host,
		detail: connection.workspace,
	}));
	disposables.add(picker.onDidAccept(item => {
		picker.hide();
		void connectToRemote(item.connection, connections, dialogs);
	}));
	disposables.add(picker.onDidHide(() => disposables.dispose()));
	picker.show();
}

async function connectToRemote(connection: RemoteConnectionDefinition, connections: IRemoteConnectionService, dialogs: IDialogService): Promise<void> {
	const confirmed = await dialogs.confirm({
		title: "Open Remote Window",
		message: `Open a new Ash window for '${connection.name}'?`,
		detail: `${connection.host}:${connection.workspace}`,
		primaryButton: "Open Remote Window",
	});
	if (!confirmed) return;
	try {
		await connections.connect(connection.name);
	} catch (error) {
		await showConnectionError(dialogs, "Could not connect to the Remote Workspace", error);
	}
}

function showConnectionError(dialogs: IDialogService, message: string, error: unknown): Promise<void> {
	return dialogs.showMessage({
		severity: DialogSeverity.Error,
		title: "Remote connection failed",
		message,
		detail: error instanceof Error ? error.message : String(error),
	});
}
