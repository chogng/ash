import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { commandActionLabel } from '../../../../../platform/action/common/action.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAccountService, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IGitHubConnectionService } from '../../../../services/accounts/common/gitHubConnectionService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ManageAccountsAction } from '../../browser/actions/manageAccountsAction.js';

test('Manage Accounts command opens account actions and signs out only after a second choice', async () => {
	const operations: string[] = [];
	const quickInput = new TestQuickInputService();
	const accountService = accountFixture({
		revision: 1n,
		accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', displayName: 'Ash User', status: 'ready', credentialRevision: 1n }],
	}, operations);
	using environment = new AccountActionEnvironment(accountService, quickInput, operations);
	using registration = registerAction2(ManageAccountsAction);

	await environment.commands.executeCommand(ManageAccountsAction.ID);
	const accountPicker = quickInput.pickers[0]!;
	assert.deepEqual(accountPicker.items.map(item => item.label), ['Ash User', 'Add account']);
	assert.equal(accountPicker.ariaLabel, 'Select an account to manage');
	accountPicker.accept(accountPicker.items[0]!);
	assert.deepEqual(operations, ['read']);

	const actionPicker = quickInput.pickers[1]!;
	assert.equal(actionPicker.ariaLabel, 'Manage Ash User');
	assert.deepEqual(actionPicker.items.map(item => item.label), ['Sign out of Ash User']);
	actionPicker.accept(actionPicker.items[0]!);
	assert.deepEqual(operations, ['read', 'logout:chatgpt-subscription']);
});

test('Manage Accounts command offers product login methods when no account is connected', async () => {
	const operations: string[] = [];
	const quickInput = new TestQuickInputService();
	using environment = new AccountActionEnvironment(accountFixture({ revision: 1n, accounts: [] }, operations), quickInput, operations);
	using registration = registerAction2(ManageAccountsAction);

	await environment.commands.executeCommand(ManageAccountsAction.ID);
	assert.deepEqual(quickInput.pickers[0]!.items.map(item => item.label), ['Add account']);
	quickInput.pickers[0]!.accept(quickInput.pickers[0]!.items[0]!);
	assert.deepEqual(quickInput.pickers[1]!.items.map(item => item.label), ['Sign in with ChatGPT', 'Connect GitHub']);
	quickInput.pickers[1]!.accept(quickInput.pickers[1]!.items[0]!);
	await environment.commands.executeCommand(ManageAccountsAction.ID);
	quickInput.pickers[2]!.accept(quickInput.pickers[2]!.items[0]!);
	quickInput.pickers[3]!.accept(quickInput.pickers[3]!.items[1]!);
	assert.deepEqual(operations, ['read', 'login:openAiChatGptBrowser', 'read', 'github:connect']);
});

test('Manage Accounts command offers sign in when an account needs reauthentication', async () => {
	const operations: string[] = [];
	const quickInput = new TestQuickInputService();
	using environment = new AccountActionEnvironment(accountFixture({
		revision: 1n,
		accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', displayName: 'Ash User', status: 'reauthenticationRequired', credentialRevision: 1n }],
	}, operations), quickInput, operations);
	using registration = registerAction2(ManageAccountsAction);

	await environment.commands.executeCommand(ManageAccountsAction.ID);
	const picker = quickInput.pickers[0]!;
	assert.deepEqual(picker.items.map(item => item.label), ['Ash User', 'Add account']);
	picker.accept(picker.items[1]!);
	assert.deepEqual(quickInput.pickers[1]!.items.map(item => item.label), ['Sign in with ChatGPT', 'Connect GitHub']);
	quickInput.pickers[1]!.accept(quickInput.pickers[1]!.items[0]!);
	assert.deepEqual(operations, ['read', 'login:openAiChatGptBrowser']);
});

test('Manage Accounts command offers cancellation for a pending GitHub connection', async () => {
	const operations: string[] = [];
	const quickInput = new TestQuickInputService();
	using environment = new AccountActionEnvironment(accountFixture({ revision: 1n, accounts: [] }, operations), quickInput, operations);
	using registration = registerAction2(ManageAccountsAction);
	environment.github.isConnecting = true;

	await environment.commands.executeCommand(ManageAccountsAction.ID);
	quickInput.pickers[0]!.accept(quickInput.pickers[0]!.items[0]!);
	assert.deepEqual(quickInput.pickers[1]!.items.map(item => item.label), ['Sign in with ChatGPT', 'Cancel GitHub connection']);
	quickInput.pickers[1]!.accept(quickInput.pickers[1]!.items[1]!);
	assert.deepEqual(operations, ['read', 'github:cancel']);
});

test('Manage Accounts command reports a failed sign out', async () => {
	const operations: string[] = [];
	const quickInput = new TestQuickInputService();
	const accounts = accountFixture({
		revision: 1n,
		accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', displayName: 'Ash User', status: 'ready', credentialRevision: 1n }],
	}, operations);
	accounts.logout = async () => { throw new Error('logout failed'); };
	using environment = new AccountActionEnvironment(accounts, quickInput, operations);
	using registration = registerAction2(ManageAccountsAction);

	await environment.commands.executeCommand(ManageAccountsAction.ID);
	quickInput.pickers[0]!.accept(quickInput.pickers[0]!.items[0]!);
	quickInput.pickers[1]!.accept(quickInput.pickers[1]!.items[0]!);
	await Promise.resolve();
	assert.deepEqual(environment.errors, ['Could not sign out of Ash User.']);
});

test('Manage Accounts command reports a failed account read without opening a picker', async () => {
	const operations: string[] = [];
	const quickInput = new TestQuickInputService();
	const accounts = accountFixture({ revision: 1n, accounts: [] }, operations);
	accounts.read = async () => { throw new Error('backend unavailable'); };
	using environment = new AccountActionEnvironment(accounts, quickInput, operations);
	using registration = registerAction2(ManageAccountsAction);

	await environment.commands.executeCommand(ManageAccountsAction.ID);
	assert.deepEqual({ pickers: quickInput.pickers.length, errors: environment.errors }, {
		pickers: 0,
		errors: ['Could not load accounts.'],
	});
});

test('Manage Accounts command and picker use the selected language', async () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const operations: string[] = [];
		const quickInput = new TestQuickInputService();
		using environment = new AccountActionEnvironment(accountFixture({ revision: 1n, accounts: [] }, operations), quickInput, operations);
		using registration = registerAction2(ManageAccountsAction);
		await environment.commands.executeCommand(ManageAccountsAction.ID);
		assert.deepEqual({ title: commandActionLabel(new ManageAccountsAction().desc.title), picker: quickInput.pickers[0]!.ariaLabel, addAccount: quickInput.pickers[0]!.items[0]!.label }, {
			title: '管理账户',
			picker: '选择要管理的账户',
			addAccount: '添加账户',
		});
	} finally {
		resetNlsResolver();
	}
});

function accountFixture(state: AccountState, operations: string[]): IAccountService {
	return {
		onDidChangeAccounts: Event.None,
		onDidCompleteLogin: Event.None,
		read: async () => { operations.push('read'); return state; },
		startLogin: async method => { operations.push(`login:${method.type}`); return { type: 'connected', loginId: 'login' }; },
		cancelLogin: async () => {},
		logout: async provider => { operations.push(`logout:${provider}`); },
	};
}

class AccountActionEnvironment extends Disposable {
	public readonly errors: string[] = [];
	public readonly commands: CommandService;
	public readonly github: { isConnecting: boolean; connect(): Promise<void>; cancel(): Promise<void> };

	constructor(accounts: IAccountService, quickInput: IQuickInputService, operations: string[]) {
		super();
		const services = new InstantiationService();
		services.registerInstance(IAccountService, accounts);
		services.registerInstance(IQuickInputService, quickInput);
		this.github = {
			isConnecting: false,
			connect: async () => { operations.push('github:connect'); },
			cancel: async () => { operations.push('github:cancel'); },
		};
		services.registerInstance(IGitHubConnectionService, this.github);
		services.registerInstance(INotificationService, {
			error: (message: string) => { this.errors.push(message); return { close() {} }; },
		} as INotificationService);
		this.commands = this._register(new CommandService(services));
		services.registerInstance(ICommandService, this.commands);
	}
}

class TestQuickInputService implements IQuickInputService {
	public readonly pickers: TestQuickPick<IQuickPickItem>[] = [];

	public createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.pickers.push(picker as unknown as TestQuickPick<IQuickPickItem>);
		return picker;
	}

	public async input(): Promise<string | undefined> { return undefined; }
}

class TestQuickPick<TItem extends IQuickPickItem> extends Disposable implements IQuickPick<TItem> {
	private readonly accepted = this._register(new Emitter<TItem>());
	private readonly hidden = this._register(new Emitter<void>());
	public readonly onDidAccept = this.accepted.event;
	public readonly onDidHide = this.hidden.event;
	public readonly onDidChangeValue = Event.None;
	public readonly onDidBlur = Event.None;
	public readonly onDidTriggerItemButton = Event.None;
	public items: readonly TItem[] = [];
	public ariaLabel = '';
	public placeholder = '';
	public value = '';
	public valueSelection = { start: 0, end: 0 };
	public filterValue = (value: string): string => value;

	public accept(item: TItem): void { this.accepted.fire(item); }
	public show(): void {}
	public hide(): void { this.hidden.fire(); }
}
