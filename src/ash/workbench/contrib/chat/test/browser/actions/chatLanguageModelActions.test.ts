import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, suiteSetup, test } from 'mocha';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { commandActionLabel } from '../../../../../../platform/action/common/action.js';
import { MenuId, MenusRegistry } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import type { ModelProviderCredentialStatus } from '../../../../../../platform/models/common/agentModels.js';
import { IQuickInputService, type IInputOptions, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IPreferencesService } from '../../../../../services/preferences/common/preferences.js';
import { registerLanguageModelActions } from '../../../browser/actions/chatLanguageModelActions.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';

const id = 'workbench.action.chat.manageLanguageModelAuthentication';
const chinese = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8'));
const direct: ModelProviderCredentialStatus = { connection: 'direct', provider: 'openai', displayName: 'Direct OpenAI', access: 'apiKey', active: true, configured: true, ready: true, apiKeyPolicy: 'required', apiKeyConfigured: true };

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly quick: TestQuickInputService;
	readonly calls: unknown[][] = [];
	readonly passwords: IInputOptions[] = [];
	providers = [direct];
	disabled = false;
	confirmed = false;
	key: string | undefined = 'new-key';
	error: Error | undefined;
	constructor() {
		super();
		const container = document.createElement('div'); document.body.append(container);
		this._register(toDisposable(() => container.remove()));
		this._register(setARIAContainer(container));
		this.quick = this._register(new TestQuickInputService({ container }));
		this.services.registerInstance(IQuickInputService, {
			createQuickPick: this.quick.createQuickPick.bind(this.quick),
			input: async (options: IInputOptions) => { this.passwords.push(options); return this.key; },
		} as unknown as IQuickInputService);
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
		this.services.registerInstance(ILanguageModelsService, {
			listModelProviders: async () => { this.calls.push(['list']); return this.providers; },
			setModelProviderApiKey: async (connection: string, key: string) => { this.calls.push(['set', connection, key]); if (this.error) throw this.error; },
			removeModelProviderApiKey: async (connection: string) => { this.calls.push(['remove', connection]); },
		} as unknown as ILanguageModelsService);
		this.services.registerInstance(IDialogService, { confirm: async () => { this.calls.push(['confirm']); return { confirmed: this.confirmed }; } } as unknown as IDialogService);
		this.services.registerInstance(IPreferencesService, { openSettings: async (options: unknown) => { this.calls.push(['settings', options]); } } as unknown as IPreferencesService);
	}
	async run(): Promise<void> { await this.services.invokeFunction(CommandsRegistry.getCommand(id)!); }
	async select(label: string): Promise<void> {
		await Promise.resolve();
		const picker = this.quick.currentQuickInput as IQuickPick<IQuickPickItem>;
		assert.ok(picker, 'the production Quick Pick is visible');
		const item = picker.items.find((item): item is IQuickPickItem => !('type' in item) && item.label === label); assert.ok(item, label);
		picker.activeItems = [item];
		await this.quick.accept();
	}
}

suite('Manage model connection access', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	suiteSetup(() => {
		setNlsMessages('zh-CN', chinese);
		try { registerLanguageModelActions(); } finally { resetNlsResolver(); }
	});

	test('sets a key through the original credential owner using a password input', async () => {
		using f = new Fixture(); const operation = f.run();
		await f.select('Direct OpenAI'); await f.select('Set API Key...'); await operation;
		assert.equal(f.passwords[0].password, true);
		assert.equal(f.passwords[0].value, undefined);
		assert.deepEqual(f.calls, [['list'], ['set', 'direct', 'new-key']]);
		assert.equal(f.quick.currentQuickInput, undefined);
	});

	for (const confirmed of [false, true]) test('removing a key requires explicit confirmation: ' + confirmed, async () => {
		using f = new Fixture(); f.confirmed = confirmed; const operation = f.run();
		await f.select('Direct OpenAI'); await f.select('Remove API Key...'); await operation;
		assert.deepEqual(f.calls, confirmed ? [['list'], ['confirm'], ['remove', 'direct']] : [['list'], ['confirm']]);
	});

	test('a subscription connection uses its original Models settings without direct-key actions', async () => {
		using f = new Fixture(); f.providers = [{ ...direct, connection: 'subscription', displayName: 'Subscription', access: 'subscription', apiKeyPolicy: 'unsupported' }];
		const operation = f.run(); await f.select('Subscription'); await Promise.resolve();
		assert.deepEqual((f.quick.currentQuickInput as IQuickPick<IQuickPickItem>).items.map(item => item.label), ['Open Models Settings']);
		await f.select('Open Models Settings'); await operation;
		assert.deepEqual(f.calls, [['list'], ['settings', { section: 'models', query: '', sectionQuery: 'subscription', jsonEditor: false, focusSearch: true }]]);
	});

	test('cancelling the password and either picker never writes credentials', async () => {
		for (const stage of ['connection', 'action', 'password']) {
			using f = new Fixture(); f.key = undefined; const operation = f.run();
			await Promise.resolve();
			if (stage !== 'connection') await f.select('Direct OpenAI');
			if (stage === 'password') await f.select('Set API Key...');
			else await f.quick.cancel();
			await operation; assert.deepEqual(f.calls, [['list']]);
		}
	});

	test('AI disablement blocks direct execution and a pending action', async () => {
		using f = new Fixture(); f.disabled = true; await f.run(); assert.deepEqual(f.calls, []);
		f.disabled = false; const operation = f.run(); await f.select('Direct OpenAI');
		f.disabled = true; await f.select('Set API Key...'); await operation;
		assert.deepEqual(f.calls, [['list']]); assert.deepEqual(f.passwords, []);
	});

	test('an empty connection catalog opens the existing management page', async () => {
		using f = new Fixture(); f.providers = []; await f.run();
		assert.deepEqual(f.calls, [['list'], ['settings', { section: 'models', query: '', sectionQuery: '', jsonEditor: false, focusSearch: true }]]);
	});

	test('credential errors propagate and release the picker', async () => {
		using f = new Fixture(); f.error = new Error('Credential store unavailable'); const operation = f.run();
		await f.select('Direct OpenAI'); await f.select('Set API Key...');
		await assert.rejects(operation, error => error === f.error);
		assert.equal(f.quick.currentQuickInput, undefined);
	});

	test('the registered command has a Chinese palette label', () => {
		const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === id);
		assert.ok(item && 'command' in item);
		assert.equal(commandActionLabel(item.command.title), '管理语言模型访问…');
	});
});
