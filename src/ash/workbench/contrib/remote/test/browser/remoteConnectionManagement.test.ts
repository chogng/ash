import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { QuickInputType, type IQuickPickDidAcceptEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { Event as QuickPickTestEvent } from '../../../../../base/common/event.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { DialogResult, type IDialogService, type IPromptDialogOptions } from "../../../../../platform/dialogs/common/dialogs.js";
import type { IConfirmationDialogOptions } from "../../../../../platform/dialogs/common/dialogs.js";
import type { IMessageDialogOptions } from "../../../../../platform/dialogs/common/dialogs.js";
import type { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IQuickPick } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import { IRemoteConnectionApi, RemoteConnectionService } from "../../../../../platform/remote/common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../../../../../platform/remote/common/remoteConnectionService.js";
import { showRemoteConnectionManager } from "../../browser/remoteConnectionManagement.js";
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';

const BuildConnection = Object.freeze({ name: "build", host: "build-linux", workspace: "/srv/project" });

test('Remote connection manager accepts Windows paths with a translated prompt', async () => {
	initializeTestLocalization('zh-CN');
	try {
		const quickInput = new TestQuickInputService();
		const connections = new TestRemoteConnectionService([]);
		using services = new InstantiationService();
		services.registerInstance(IRemoteConnectionApi, connections);
		using service = services.createInstance(RemoteConnectionService);
		const operation = showRemoteConnectionManager(service, quickInput, new TestDialogService());
		await acceptPicker(quickInput, 0);
		await enterText(quickInput, 1, 'windows');
		await enterText(quickInput, 2, 'windows-dev');
		assert.match((await pickerAt(quickInput, 3)).placeholder ?? '', /远程工作区.*C:\/work\/project/);
		await enterText(quickInput, 3, 'c:\\work\\开发 project');
		await operation;
		assert.deepEqual(connections.saved, [{ name: 'windows', host: 'windows-dev', workspace: 'c:\\work\\开发 project' }]);
	} finally {
		initializeTestLocalization('en');
	}
});

test("Remote connection manager adds a credential-free target", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connections = new TestRemoteConnectionService([]);
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using service = services.createInstance(RemoteConnectionService);
	const operation = showRemoteConnectionManager(service, quickInput, dialogs);

	await acceptPicker(quickInput, 0);
	await enterText(quickInput, 1, "build");
	await enterText(quickInput, 2, "build-linux");
	await enterText(quickInput, 3, "/srv/project");
	await operation;

	assert.deepEqual(connections.saved, [BuildConnection]);
	assert.equal(dialogs.messages.at(-1)?.message, "Remote connection saved");
});

test("Remote connection manager atomically edits and renames one observed target", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connections = new TestRemoteConnectionService([BuildConnection]);
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using service = services.createInstance(RemoteConnectionService);
	const operation = showRemoteConnectionManager(service, quickInput, dialogs);

	await acceptPicker(quickInput, 0, 1);
	await acceptPicker(quickInput, 1);
	await enterText(quickInput, 2, "production");
	await enterText(quickInput, 3, "production-linux");
	await enterText(quickInput, 4, "/srv/production");
	await operation;

	assert.deepEqual(connections.updated, [["build", { name: "production", host: "production-linux", workspace: "/srv/production" }]]);
	assert.equal(dialogs.messages.at(-1)?.message, "Remote connection updated");
});

test("Remote connection manager removes only after confirmation", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connections = new TestRemoteConnectionService([BuildConnection]);
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using service = services.createInstance(RemoteConnectionService);
	const operation = showRemoteConnectionManager(service, quickInput, dialogs);

	await acceptPicker(quickInput, 0, 2);
	await acceptPicker(quickInput, 1);
	await operation;

	assert.deepEqual(connections.removed, ["build"]);
	assert.equal(dialogs.confirmations[0]?.primaryButton, "Remove");
	assert.equal(dialogs.messages.at(-1)?.message, "Remote connection removed");
});

test("Remote connection manager leaves the catalog unchanged when removal is cancelled", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	dialogs.confirmResult = false;
	const connections = new TestRemoteConnectionService([BuildConnection]);
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using service = services.createInstance(RemoteConnectionService);
	const operation = showRemoteConnectionManager(service, quickInput, dialogs);

	await acceptPicker(quickInput, 0, 2);
	await acceptPicker(quickInput, 1);
	await operation;

	assert.deepEqual(connections.removed, []);
	assert.deepEqual(dialogs.messages, []);
});

test("Remote connection manager cancellation performs no catalog mutation", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connections = new TestRemoteConnectionService([]);
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using service = services.createInstance(RemoteConnectionService);
	const operation = showRemoteConnectionManager(service, quickInput, dialogs);

	await acceptPicker(quickInput, 0);
	const namePicker = await pickerAt(quickInput, 1);
	namePicker.hide();
	await operation;

	assert.deepEqual(connections.saved, []);
	assert.deepEqual(dialogs.messages, []);
});

test("Remote connection manager reports catalog mutation failures", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connections = new TestRemoteConnectionService([]);
	connections.saveError = new Error("connection already exists");
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using service = services.createInstance(RemoteConnectionService);
	const operation = showRemoteConnectionManager(service, quickInput, dialogs);

	await acceptPicker(quickInput, 0);
	await enterText(quickInput, 1, "build");
	await enterText(quickInput, 2, "build-linux");
	await enterText(quickInput, 3, "/srv/project");
	await operation;

	assert.equal(dialogs.messages.at(-1)?.detail, "connection already exists");
});

class TestRemoteConnectionService implements IRemoteConnectionApi {
	readonly available = true;
	readonly saved: RemoteConnectionDefinition[] = [];
	readonly updated: [string, RemoteConnectionDefinition][] = [];
	readonly removed: string[] = [];
	saveError: Error | undefined;

	constructor(private readonly connections: readonly RemoteConnectionDefinition[]) { }

	async list(): Promise<readonly RemoteConnectionDefinition[]> { return this.connections; }
	async save(connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition> {
		if (this.saveError) throw this.saveError;
		this.saved.push(connection);
		return connection;
	}
	async update(originalName: string, connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition> {
		this.updated.push([originalName, connection]);
		return connection;
	}
	async remove(name: string): Promise<RemoteConnectionDefinition | undefined> {
		this.removed.push(name);
		return this.connections.find(connection => connection.name === name);
	}
	async connect(): Promise<void> { }
}

class TestQuickInputService implements IQuickInputService {
	readonly quickAccess = quickInputServiceTestControls.quickAccess;
	readonly onShow = quickInputServiceTestControls.onShow;
	readonly onHide = quickInputServiceTestControls.onHide;
	readonly currentQuickInput = undefined;
	focus = quickInputServiceTestControls.focus;
	toggle = quickInputServiceTestControls.toggle;
	setAlignment = quickInputServiceTestControls.setAlignment;
	navigate = quickInputServiceTestControls.navigate;
	accept = quickInputServiceTestControls.accept;
	cancel = quickInputServiceTestControls.cancel;

	readonly pickers: TestQuickPick<IQuickPickItem>[] = [];
	async input(): Promise<string | undefined> { return undefined; }

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.pickers.push(picker as unknown as TestQuickPick<IQuickPickItem>);
		return picker;
	}
}

class TestQuickPick<TItem extends IQuickPickItem> implements IQuickPick<TItem> {
	readonly type = QuickInputType.QuickPick;
	activeItems: readonly TItem[] = [];
	focus(): void { }
	toggle(): void { }
	accept(inBackground = false): void { this.selectedItems = this.activeItems; this.acceptEmitter.fire({ inBackground }); }

	canSelectMany = false;
	selectedItems: readonly TItem[] = [];
	readonly onDidChangeSelection = QuickPickTestEvent.None;
	sortByLabel = true;
	private readonly acceptEmitter = new Emitter<IQuickPickDidAcceptEvent>();
	private readonly valueEmitter = new Emitter<string>();
	private readonly hideEmitter = new Emitter<void>();
	private visible = false;
	readonly onDidAccept = this.acceptEmitter.event;
	readonly onDidChangeValue = this.valueEmitter.event;
	readonly onDidHide = this.hideEmitter.event;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	items: readonly TItem[] = [];
	ariaLabel = '';
	placeholder = "";
	value = "";
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string): string => value;

	chooseItem(index = 0): void {
		const item = this.items[index];
		if (item) { this.selectedItems = [item]; this.acceptEmitter.fire({ inBackground: false }); }
	}

	setQuery(value: string): void {
		this.value = value;
		this.valueEmitter.fire(value);
	}

	show(): void { this.visible = true; }
	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.hideEmitter.fire();
	}
	dispose(): void {
		this.acceptEmitter.dispose();
		this.valueEmitter.dispose();
		this.hideEmitter.dispose();
	}
	[Symbol.dispose](): void { this.dispose(); }
}

class TestDialogService implements IDialogService {
	readonly onWillShowDialog = Event.None;
	readonly onDidShowDialog = Event.None;
	readonly messages: IMessageDialogOptions[] = [];
	readonly confirmations: IConfirmationDialogOptions[] = [];
	confirmResult = true;

	async showMessage(options: IMessageDialogOptions): Promise<void> { this.messages.push(options); }
	async info(): Promise<void> { }
	async warn(): Promise<void> { }
	async error(): Promise<void> { }
	async about(): Promise<void> { throw new Error('Unexpected about dialog'); }
	async confirm(options: IConfirmationDialogOptions): Promise<{ confirmed: boolean; }> {
		this.confirmations.push(options);
		return { confirmed: this.confirmResult };
	}
	async prompt(): Promise<never> { throw new Error('Unexpected prompt'); }
	async input(): Promise<never> { throw new Error('Unexpected input dialog'); }
}

async function acceptPicker(quickInput: TestQuickInputService, pickerIndex: number, itemIndex = 0): Promise<void> {
	const picker = await pickerAt(quickInput, pickerIndex);
	picker.chooseItem(itemIndex);
}

async function enterText(quickInput: TestQuickInputService, pickerIndex: number, value: string): Promise<void> {
	const picker = await pickerAt(quickInput, pickerIndex);
	picker.setQuery(value);
	picker.chooseItem();
}

async function pickerAt(quickInput: TestQuickInputService, index: number): Promise<TestQuickPick<IQuickPickItem>> {
	await waitUntil(() => quickInput.pickers.length > index);
	return quickInput.pickers[index]!;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.fail("condition did not become true");
}
