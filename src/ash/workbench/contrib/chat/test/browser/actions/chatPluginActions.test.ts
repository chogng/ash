import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, suiteSetup, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { commandActionLabel } from '../../../../../../platform/action/common/action.js';
import { MenuId, MenusRegistry } from '../../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../../platform/chat/common/chatSettings.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { getChatInputAccessibilityHelp } from '../../../browser/actions/chatAccessibilityHelp.js';

const id = 'workbench.action.chat.managePlugins';
const chinese = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8'));
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
			const module = await import('../../../browser/actions/chatPluginActions.js');
			importedWithoutCommands = CommandsRegistry.getCommand(id) === undefined;
			module.registerChatPluginActions();
		} finally { resetNlsResolver(); }
	});

	test('explicit registration exposes a localized Chat command only when AI is enabled', () => {
		assert.equal(importedWithoutCommands, true);
		const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === id);
		assert.ok(item && 'command' in item);
		assert.equal(commandActionLabel(item.command.title), '插件');
		assert.equal(commandActionLabel(item.command.category!), '聊天');
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
});
