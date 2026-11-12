import { languagePackCatalog as chineseCatalog } from '../../../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { commandActionLabel } from '../../../../../../platform/action/common/action.js';
import { MenuId, MenusRegistry, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../../platform/chat/common/chatSettings.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsInstalledPackage, type ExtensionsPackageDetails } from '../../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { getChatInputAccessibilityHelp } from '../../../browser/actions/chatAccessibilityHelp.js';

const id = 'workbench.action.chat.managePlugins';
const updateId = 'workbench.agentPlugins.checkForUpdates';
const chinese = chineseCatalog.bundles;
let importedWithoutCommands = false;

function fixture() {
	const services = new InstantiationService();
	const calls: unknown[][] = [];
	const state = { disabled: false, error: undefined as Error | undefined };
	services.registerInstance(IConfigurationService, {
		getValue: (key: string) => { assert.equal(key, ChatAIDisabledSettingId); return state.disabled; },
	} as unknown as IConfigurationService);
	services.registerInstance(ICommandService, {
		executeCommand: async (...args: unknown[]) => { calls.push(args); if (state.error) throw state.error; },
	} as unknown as ICommandService);
	return { services, calls, state, run: async () => { await services.invokeFunction(CommandsRegistry.getCommand(id)!); } };
}

suite('Chat plugin commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	suiteSetup(async () => {
		setNlsMessages('zh-CN', chinese);
		try {
			const module = await import('../../../browser/agentPluginsView.js');
			importedWithoutCommands = CommandsRegistry.getCommand(id) === undefined;
			registerAction2(module.AgentPluginsBrowseCommand);
			const updates = await import('../../../browser/agentPluginCommands.js');
			registerAction2(updates.UpdateAgentPluginsCommand);
		} finally { resetNlsResolver(); }
	});

	test('explicit registration exposes a localized Chat command only when AI is enabled', () => {
		assert.equal(importedWithoutCommands, true);
		const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === id);
		assert.ok(item && 'command' in item);
		assert.equal(commandActionLabel(item.command.title), '插件');
		assert.equal(commandActionLabel(item.command.category!), '聊天');
		const update = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === updateId);
		assert.ok(update && 'command' in update);
		assert.equal(commandActionLabel(update.command.title), '更新插件');
		using context = new ContextKeyService();
		const enabled = ChatContextKeys.enabled.bindTo(context);
		enabled.set(false); assert.equal(context.contextMatchesRules(item.command.precondition), false);
		enabled.set(true); assert.equal(context.contextMatchesRules(item.command.precondition), true);
	});

	test('the registered command opens the existing Extensions owner with a fresh Plugins filter each time', async () => {
		const f = fixture(); using services = f.services;
		await f.run(); await f.run();
		assert.deepEqual(f.calls, [
			[OPEN_EXTENSIONS_COMMAND_ID, { query: '@plugins ' }],
			[OPEN_EXTENSIONS_COMMAND_ID, { query: '@plugins ' }],
		]);
	});

	test('direct invocation respects AI disablement without opening Extensions', async () => {
		const f = fixture(); using services = f.services;
		f.state.disabled = true;
		await f.run();
		assert.deepEqual(f.calls, []);
	});

	test('navigation failures reach the caller and a subsequent invocation can open again', async () => {
		const f = fixture(); using services = f.services;
		f.state.error = new Error('Extensions could not open');
		await assert.rejects(f.run(), error => error === f.state.error);
		f.state.error = undefined;
		await f.run();
		assert.equal(f.calls.length, 2);
	});

	test('Chinese Chat help describes the Plugins destination and keyboard flow', () => {
		setNlsMessages('zh-CN', chinese);
		try { assert.match(getChatInputAccessibilityHelp('', false, false), /聊天：插件.*搜索框.*按 Enter 打开详情.*保留消息草稿/u); }
		finally { resetNlsResolver(); }
	});

	test('the registered update command updates only newer stable signed plugins and coalesces concurrent requests', async () => {
		const f = fixture(); using services = f.services;
		const entries = [
			{ id: 'plugin', kind: 'plugin', current: '1.2.0', latest: '1.10.0' },
			{ id: 'editor', kind: 'editor', current: '1.0.0', latest: '2.0.0' },
			{ id: 'prerelease', kind: 'plugin', current: '1.0.0', latest: '2.0.0-beta.1' },
			{ id: 'ahead', kind: 'plugin', current: '2.0.0', latest: '1.0.0' },
			{ id: 'pending', kind: 'plugin', current: '1.0.0', latest: '2.0.0' },
			{ id: 'wrong-digest', kind: 'plugin', current: '1.0.0', latest: '2.0.0' },
			{ id: 'changed-type', kind: 'plugin', current: '1.0.0', latest: '2.0.0' },
			{ id: 'unavailable', kind: 'plugin', current: '1.0.0', latest: '2.0.0' },
		];
		const installed: ExtensionsInstalledPackage[] = entries.map(entry => ({
			installationId: entry.id,
			state: entry.id === 'pending' ? 'pendingRemoval' : 'installed',
			package: { id: entry.id, version: entry.current, digest: entry.id },
			capabilities: [],
		}));
		let lists = 0;
		const updates: [string, string | undefined][] = [];
		const results: [string, string | undefined][] = [];
		const get = async (id: string, version?: string): Promise<ExtensionsPackageDetails> => {
			const entry = entries.find(entry => entry.id === id)!;
			if (id === 'unavailable') throw new Error('Registry unavailable');
			return {
				package: { id, version: version ?? entry.latest, digest: id === 'wrong-digest' ? 'other' : id },
				packageType: id === 'changed-type' && !version ? 'editor' : entry.kind,
				displayName: id, description: '', license: '', source: 'official', upstream: null, capabilities: [],
			};
		};
		const extensions = {
			listInstalled: async () => { lists++; return installed; },
			get,
			update: async (id: string, version?: string) => {
				updates.push([id, version]);
				return { ...installed[0]!, package: (await get(id, version)).package };
			},
		} satisfies Pick<IExtensionManagementService, 'listInstalled' | 'get' | 'update'>;
		services.registerInstance(IExtensionManagementService, extensions as unknown as IExtensionManagementService);
		services.registerInstance(IDialogService, {
			info: async (summary: string, detail?: string) => { results.push([summary, detail]); },
		} as IDialogService);
		const run = () => services.invokeFunction(CommandsRegistry.getCommand(updateId)!);

		setNlsMessages('zh-CN', chinese);
		try {
			await Promise.all([run(), run()]);
			assert.equal(lists, 1);
			assert.deepEqual(updates, [['plugin', '1.10.0']]);
			assert.deepEqual(results, [['已更新 1 个插件。无法验证或更新 2 个包。', 'plugin：1.2.0 → 1.10.0\n无法验证或更新：wrong-digest, unavailable']]);
			f.state.disabled = true;
			await run();
			assert.equal(lists, 1);
		} finally { resetNlsResolver(); }
	});
});
