import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { DialogSeverity } from "../../../../platform/dialogs/common/dialogs.js";
import type { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import type { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import type { IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import type { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../../../../platform/remote/common/remoteConnectionService.js";

type ManagementAction = "add" | "edit" | "remove";

interface ManagementQuickPickItem extends IQuickPickItem {
	readonly action: ManagementAction;
}

interface ConnectionQuickPickItem extends IQuickPickItem {
	readonly connection: RemoteConnectionDefinition;
}

interface TextQuickPickItem extends IQuickPickItem {
	readonly text: string;
}

/** Opens the graphical editor for the shared credential-free Remote connection catalog. */
export async function showRemoteConnectionManager(connections: IRemoteConnectionService, quickInput: IQuickInputService, dialogs: IDialogService): Promise<void> {
	let available: readonly RemoteConnectionDefinition[];
	try {
		available = await connections.list();
	} catch (error) {
		await showManagementError(dialogs, "Could not load saved Remote connections", error);
		return;
	}

	const items: ManagementQuickPickItem[] = [{ action: "add", label: "Add SSH Host", detail: "Save a credential-free OpenSSH host alias and Remote Workspace" }];
	if (available.length > 0) {
		items.push({ action: "edit", label: "Edit SSH Host", detail: "Change or rename an existing saved connection" });
		items.push({ action: "remove", label: "Remove SSH Host", detail: "Delete an existing saved connection" });
	}
	const selected = await pickOne(quickInput, "Manage saved Remote SSH hosts", items);
	if (!selected) return;
	switch (selected.action) {
		case "add":
			await addConnection(connections, quickInput, dialogs);
			break;
		case "edit":
			await editConnection(connections, quickInput, dialogs, available);
			break;
		case "remove":
			await removeConnection(connections, quickInput, dialogs, available);
			break;
	}
}

async function addConnection(connections: IRemoteConnectionService, quickInput: IQuickInputService, dialogs: IDialogService): Promise<void> {
	const connection = await promptConnection(quickInput);
	if (!connection) return;
	try {
		const saved = await connections.save(connection);
		await showManagementSuccess(dialogs, "Remote connection saved", `'${saved.name}' now points to ${saved.host}:${saved.workspace}`);
	} catch (error) {
		await showManagementError(dialogs, "Could not save the Remote connection", error);
	}
}

async function editConnection(connections: IRemoteConnectionService, quickInput: IQuickInputService, dialogs: IDialogService, available: readonly RemoteConnectionDefinition[]): Promise<void> {
	const original = await pickConnection(quickInput, "Select a Remote SSH host to edit", available);
	if (!original) return;
	const connection = await promptConnection(quickInput, original);
	if (!connection) return;
	try {
		const updated = await connections.update(original.name, connection);
		await showManagementSuccess(dialogs, "Remote connection updated", `'${updated.name}' now points to ${updated.host}:${updated.workspace}`);
	} catch (error) {
		await showManagementError(dialogs, "Could not update the Remote connection", error);
	}
}

async function removeConnection(connections: IRemoteConnectionService, quickInput: IQuickInputService, dialogs: IDialogService, available: readonly RemoteConnectionDefinition[]): Promise<void> {
	const connection = await pickConnection(quickInput, "Select a Remote SSH host to remove", available);
	if (!connection) return;
	const confirmed = await dialogs.confirm({
		title: "Remove Remote connection",
		message: `Remove '${connection.name}' from saved Remote connections?`,
		detail: `${connection.host}:${connection.workspace}`,
		primaryButton: "Remove",
	});
	if (!confirmed) return;
	try {
		const removed = await connections.remove(connection.name);
		await showManagementSuccess(
			dialogs,
			removed ? "Remote connection removed" : "Remote connection already removed",
			removed ? `'${removed.name}' was removed from the shared catalog.` : `'${connection.name}' no longer exists in the shared catalog.`,
		);
	} catch (error) {
		await showManagementError(dialogs, "Could not remove the Remote connection", error);
	}
}

async function promptConnection(quickInput: IQuickInputService, initial?: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition | undefined> {
	const name = await promptText(quickInput, "Connection name (letters, digits, dots, underscores, or hyphens)", initial?.name);
	if (name === undefined) return undefined;
	const host = await promptText(quickInput, "OpenSSH config host alias", initial?.host);
	if (host === undefined) return undefined;
	const workspace = await promptText(quickInput, "Absolute POSIX path to the Remote Workspace", initial?.workspace);
	if (workspace === undefined) return undefined;
	return { name, host, workspace };
}

function pickConnection(quickInput: IQuickInputService, placeholder: string, connections: readonly RemoteConnectionDefinition[]): Promise<RemoteConnectionDefinition | undefined> {
	return pickOne(quickInput, placeholder, connections.map(connection => ({
		connection,
		label: connection.name,
		description: connection.host,
		detail: connection.workspace,
	}))).then(item => item?.connection);
}

function promptText(quickInput: IQuickInputService, placeholder: string, initialValue = ""): Promise<string | undefined> {
	const picker = quickInput.createQuickPick<TextQuickPickItem>();
	const updateItem = (value: string): void => {
		picker.items = value.trim() ? [{ text: value, label: value }] : [];
	};
	picker.placeholder = placeholder;
	picker.value = initialValue;
	updateItem(initialValue);
	const disposables = new DisposableStore();
	disposables.add(picker);
	disposables.add(picker.onDidChangeValue(updateItem));
	return new Promise(resolve => {
		let settled = false;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(value);
			picker.hide();
		};
		disposables.add(picker.onDidAccept(item => finish(item.text)));
		disposables.add(picker.onDidHide(() => {
			finish(undefined);
			disposables.dispose();
		}));
		picker.show();
	});
}

function pickOne<TItem extends IQuickPickItem>(quickInput: IQuickInputService, placeholder: string, items: readonly TItem[]): Promise<TItem | undefined> {
	const picker = quickInput.createQuickPick<TItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.placeholder = placeholder;
	picker.items = items;
	return new Promise(resolve => {
		let settled = false;
		const finish = (value: TItem | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(value);
			picker.hide();
		};
		disposables.add(picker.onDidAccept(item => finish(item)));
		disposables.add(picker.onDidHide(() => {
			finish(undefined);
			disposables.dispose();
		}));
		picker.show();
	});
}

function showManagementSuccess(dialogs: IDialogService, message: string, detail: string): Promise<void> {
	return dialogs.showMessage({ severity: DialogSeverity.Info, title: "Saved Remote connections", message, detail });
}

function showManagementError(dialogs: IDialogService, message: string, error: unknown): Promise<void> {
	return dialogs.showMessage({
		severity: DialogSeverity.Error,
		title: "Saved Remote connection failed",
		message,
		detail: error instanceof Error ? error.message : String(error),
	});
}
