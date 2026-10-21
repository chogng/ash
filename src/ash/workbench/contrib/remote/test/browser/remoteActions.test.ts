import { readFileSync } from 'node:fs';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { IAppServerApi, type IAppServerConnectionRecovery } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IBannerService, type IBannerItem } from '../../../../services/banner/browser/bannerService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ReconnectAppServerCommandId, AppServerRecoveryAvailableContext } from '../../browser/remoteActions.js';
import '../../browser/remote.contribution.js';
import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { QuickInputType, type IQuickPickDidAcceptEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { Event as QuickPickTestEvent } from '../../../../../base/common/event.js';
import { IRemoteConnectionApi, RemoteConnectionService } from '../../../../../platform/remote/common/remoteConnectionService.js';
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
import { showRemoteConnectionPicker } from "../../browser/remoteActions.js";

test("Remote connection picker shows saved credential-free targets and connects by name", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connected: string[] = [];
	const connections: IRemoteConnectionApi = {
		available: true,
		list: async () => [{ name: "build", host: "build-linux", workspace: "/srv/project" }],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async name => { connected.push(name); },
	};

	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using resolvers = services.createInstance(RemoteConnectionService);
	using registration = resolvers.registerResolvers([{ authorityPrefix: 'ssh', resolve: async authority => ({ connectionName: authority.slice(4) }) }]);
	await showRemoteConnectionPicker(resolvers, quickInput, dialogs);
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
	const connections = testRemoteConnections();
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using resolvers = services.createInstance(RemoteConnectionService);
	await showRemoteConnectionPicker(resolvers, new TestQuickInputService(), dialogs);

	assert.match(dialogs.messages[0]?.detail ?? "", /Manage Saved SSH Hosts/);
});

test("Remote connection picker reports catalog failures without opening a picker", async () => {
	const quickInput = new TestQuickInputService();
	const dialogs = new TestDialogService();
	const connections: IRemoteConnectionApi = {
		available: true,
		list: async () => { throw new Error("catalog busy"); },
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => { },
	};
	using services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, connections);
	using resolvers = services.createInstance(RemoteConnectionService);
	await showRemoteConnectionPicker(resolvers, quickInput, dialogs);

	assert.equal(quickInput.picker, undefined);
	assert.equal(dialogs.messages[0]?.detail, "catalog busy");
});

function testRemoteConnections(): IRemoteConnectionApi {
	return {
		available: true,
		list: async () => [],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => { },
	};
}

class TestQuickInputService implements IQuickInputService {
	readonly quickAccess = quickInputServiceTestControls.quickAccess;
	readonly onShow = quickInputServiceTestControls.onShow;
	readonly onHide = quickInputServiceTestControls.onHide;
	readonly currentQuickInput = undefined;
	focus = quickInputServiceTestControls.focus;
	toggle = quickInputServiceTestControls.toggle;
	navigate = quickInputServiceTestControls.navigate;
	accept = quickInputServiceTestControls.accept;
	cancel = quickInputServiceTestControls.cancel;

	picker: TestQuickPick<IQuickPickItem> | undefined;
	async input(): Promise<string | undefined> { return undefined; }

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.picker = picker as unknown as TestQuickPick<IQuickPickItem>;
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

	acceptFirst(): void {
		const item = this.items[0];
		if (item) { this.selectedItems = [item]; this.acceptEmitter.fire({ inBackground: false }); }
	}

	show(): void { }
	hide(): void { this.hideEmitter.fire(); }
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

	async showMessage(options: IMessageDialogOptions): Promise<void> {
		this.messages.push(options);
	}
	async info(): Promise<void> { }
	async warn(): Promise<void> { }
	async error(): Promise<void> { }
	async about(): Promise<void> { throw new Error('Unexpected about dialog'); }

	async confirm(options: IConfirmationDialogOptions): Promise<{ confirmed: boolean; }> {
		this.confirmations.push(options);
		return { confirmed: true };
	}

	async prompt(): Promise<never> { throw new Error('Unexpected prompt'); }
	async input(): Promise<never> { throw new Error('Unexpected input dialog'); }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.fail("condition did not become true");
}


for (const locale of ['en', 'zh-CN']) {
	test(`Agent Host recovery banner and command use the same owner and disappear on recovery (${locale})`, async () => {
		if (locale === 'zh-CN') setNlsMessages(locale, JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
		try {
			using services = new InstantiationService();
			const notices = new Map<string, IBannerItem>();
			using contexts = new ContextKeyService();
			using changed = new Emitter<void>();
			let retries = 0;
			const recovery: IAppServerConnectionRecovery & { status: IAppServerConnectionRecovery['status']; } = {
				status: 'failed', error: 'fixture offline', onDidChange: changed.event,
				reconnect: async () => { retries++; recovery.status = 'recovering'; changed.fire(); },
			};
			services.registerInstance(IAppServerApi, { connectionGeneration: 1, getConnectionState: async () => 'stopped', getSlashCommands: async () => [], onConnectionState: () => ({ dispose() { } }), recovery });
			services.registerInstance(IBannerService, {
				_serviceBrand: undefined, focus() { }, focusNextAction() { }, focusPreviousAction() { },
				show: item => { notices.set(item.id, item); }, hide: id => { notices.delete(id); },
			});
			services.registerInstance(IContextKeyService, contexts);
			using contribution = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.appServerRecovery']);
			contribution.advance(WorkbenchPhase.BlockRestore);
			const notice = [...notices.values()][0]!;
			assert.equal(notices.size, 1);
			assert.equal(notice.actions?.[0]?.label, locale === 'zh-CN' ? '重新连接' : 'Reconnect');
			assert.equal(notice.message, locale === 'zh-CN' ? '无法恢复 Agent Host 连接或工作区。请重试。' : 'Could not restore the Agent Host connection or workspace. Try again.');
			assert.equal(contexts.contextMatchesRules(AppServerRecoveryAvailableContext.isEqualTo(true)), true);
			assert.equal(notice.actions?.[0]?.href, `command:${ReconnectAppServerCommandId}`);
			await CommandsRegistry.getCommand(ReconnectAppServerCommandId)!(services);
			assert.equal(retries, 1);
			assert.equal(notices.size, 1);
			assert.equal([...notices.values()][0]!.message, locale === 'zh-CN' ? '正在重新连接到 Agent Host…' : 'Reconnecting to the Agent Host…');
			recovery.status = 'idle'; changed.fire();
			assert.equal(notices.size, 0);
			await CommandsRegistry.getCommand(ReconnectAppServerCommandId)!(services);
			assert.equal(retries, 2);
			recovery.status = 'unavailable'; changed.fire();
			assert.equal(notices.size, 1);
			assert.equal([...notices.values()][0]!.actions?.length ?? 0, 0);
			assert.equal(contexts.contextMatchesRules(AppServerRecoveryAvailableContext.isEqualTo(true)), false);
			contribution.dispose();
			assert.equal(notices.size, 0);
			recovery.status = 'failed'; changed.fire();
			assert.equal(notices.size, 0);
		} finally { resetNlsResolver(); }
	});
}
