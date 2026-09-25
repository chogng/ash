import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { DialogResult, type IDialogService, type IPromptDialogOptions } from "../../../../../platform/dialogs/common/dialogs.js";
import type { IConfirmationDialogOptions } from "../../../../../platform/dialogs/common/dialogs.js";
import type { IMessageDialogOptions } from "../../../../../platform/dialogs/common/dialogs.js";
import type { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IQuickPick } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IRemoteConnectionService } from "../../../../../platform/remote/common/remoteConnectionService.js";
import { showRemoteConnectionPicker } from "../../browser/remoteActions.js";

test("Remote connection picker shows saved credential-free targets and connects by name", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connected: string[] = [];
	const connections: IRemoteConnectionService = {
		available: true,
		list: async () => [{ name: "build", host: "build-linux", workspace: "/srv/project" }],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async name => { connected.push(name); },
	};

	await showRemoteConnectionPicker(connections, quickInput, dialogs);
	assert.equal(quickInput.picker?.placeholder, "Select a Remote SSH connection");
	assert.deepEqual(quickInput.picker?.items, [{
		connection: { name: "build", host: "build-linux", workspace: "/srv/project" },
		label: "build",
		description: "build-linux",
		detail: "/srv/project",
	}]);
	quickInput.picker?.acceptFirst();
	await waitUntil(() => connected.length === 1);

	assert.deepEqual(connected, ["build"]);
	assert.equal(dialogs.confirmations[0]?.primaryButton, "Open Remote Window");
});

test("Remote connection picker explains how to seed an empty catalog", async () => {
	const dialogs = new TestDialogService();
	await showRemoteConnectionPicker(testRemoteConnections(), new TestQuickInputService(), dialogs);

	assert.match(dialogs.messages[0]?.detail ?? "", /Manage Saved SSH Hosts/);
});

test("Remote connection picker reports catalog failures without opening a picker", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	await showRemoteConnectionPicker({
		available: true,
		list: async () => { throw new Error("catalog busy"); },
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => {},
	}, quickInput, dialogs);

	assert.equal(quickInput.picker, undefined);
	assert.equal(dialogs.messages[0]?.detail, "catalog busy");
});

function testRemoteConnections(): IRemoteConnectionService {
	return {
		available: true,
		list: async () => [],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => {},
	};
}

class TestQuickInputService implements IQuickInputService {
	picker: TestQuickPick<IQuickPickItem> | undefined;
	async input(): Promise<string | undefined> { return undefined; }

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.picker = picker as unknown as TestQuickPick<IQuickPickItem>;
		return picker;
	}
}

class TestQuickPick<TItem extends IQuickPickItem> implements IQuickPick<TItem> {
	private readonly acceptEmitter = new Emitter<TItem>();
	private readonly valueEmitter = new Emitter<string>();
	private readonly hideEmitter = new Emitter<void>();
	readonly onDidAccept = this.acceptEmitter.event;
	readonly onDidChangeValue = this.valueEmitter.event;
	readonly onDidHide = this.hideEmitter.event;
	readonly onDidBlur = Event.None;
	items: readonly TItem[] = [];
	ariaLabel = '';
	placeholder = "";
	value = "";
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string): string => value;

	acceptFirst(): void {
		const item = this.items[0];
		if (item) this.acceptEmitter.fire(item);
	}

	show(): void {}
	hide(): void { this.hideEmitter.fire(); }
	dispose(): void {
		this.acceptEmitter.dispose();
		this.valueEmitter.dispose();
		this.hideEmitter.dispose();
	}
	[Symbol.dispose](): void { this.dispose(); }
}

class TestDialogService implements IDialogService {
	readonly messages: IMessageDialogOptions[] = [];
	readonly confirmations: IConfirmationDialogOptions[] = [];

	async showMessage(options: IMessageDialogOptions): Promise<void> {
		this.messages.push(options);
	}

	async confirm(options: IConfirmationDialogOptions): Promise<boolean> {
		this.confirmations.push(options);
		return true;
	}

	async prompt(_options: IPromptDialogOptions): Promise<DialogResult> { return DialogResult.Cancel; }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.fail("condition did not become true");
}
