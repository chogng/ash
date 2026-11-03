import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from './fixtures/newPromptFileActions.page.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import type { AgentRoleCatalog } from '../../../../../platform/agentHost/common/agent.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService, type IInputDialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IInputOptions } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { registerAgentActions } from '../../browser/promptSyntax/chatModeActions.js';
import { NEW_AGENT_COMMAND_ID, NEW_INSTRUCTIONS_COMMAND_ID, registerNewPromptFileActions } from '../../browser/promptSyntax/newPromptFileActions.js';
import { PromptFileParser } from '../../common/promptSyntax/promptFileParser.js';
import { PromptValidator } from '../../common/promptSyntax/languageProviders/promptValidator.js';

class CreationFixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly files = this._register(new FileService());
	readonly folder = URI.parse('memory:/project');
	readonly opened: URI[] = [];
	readonly notices: string[] = [];
	readonly shown = new DeferredPromise<void>();
	name: string | undefined = 'reviewer';
	disabled = false;
	nameCalls = 0;
	dialog: IInputDialogResult | Promise<IInputDialogResult> = { confirmed: true, values: ['Review code.', 'Keep the author\'s indentation.\n  Nested instruction.'] };
	snapshot = { id: 'fixture', folders: [{ id: 'root', name: 'project', uri: this.folder, index: 0 }] };
	nameOptions: IInputOptions | undefined;

	constructor() {
		super();
		this._register(this.files.registerProvider('memory', this._register(new InMemoryFileSystemProvider())));
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
		this.services.registerInstance(IWorkspaceContextService, { getWorkspace: () => this.snapshot } as unknown as IWorkspaceContextService);
		this.services.registerInstance(IAppServerRemoteAgentService, { connection: undefined } as IAppServerRemoteAgentService);
		this.services.registerInstance(IQuickInputService, {
			input: async (options: IInputOptions) => { this.nameCalls++; this.nameOptions = options; return this.name; },
		} as unknown as IQuickInputService);
		this.services.registerInstance(IDialogService, { input: async () => { await this.shown.complete(); return this.dialog; } } as unknown as IDialogService);
		this.services.registerInstance(IEditorService, { openEditor: async (input: { resource: URI; }) => { this.opened.push(input.resource); } } as unknown as IEditorService);
		this.services.registerInstance(INotificationService, { info: (message: string) => this.notices.push(message) } as unknown as INotificationService);
		this._register(registerNewPromptFileActions());
	}

	async run(id = NEW_AGENT_COMMAND_ID): Promise<void> {
		await this.services.invokeFunction(CommandsRegistry.getCommand(id)!);
	}

	target(directory = 'agents'): URI { return URI.joinPath(this.folder, '.ash', directory, 'reviewer.md'); }
}

for (const [command, directory] of [[NEW_AGENT_COMMAND_ID, 'agents'], [NEW_INSTRUCTIONS_COMMAND_ID, 'instructions']] as const) {
	test(`${command} creates a valid definition through FileService and opens the owning resource`, async () => {
		using fixture = new CreationFixture();
		await fixture.run(command);
		const target = fixture.target(directory);
		const content = (await fixture.files.readFile(target)).content;
		assert.deepEqual(new PromptValidator().validate(new PromptFileParser().parse(target, content)), []);
		assert.ok(content.includes('  Nested instruction.'));
		if (directory === 'instructions') { assert.ok(content.includes('load: on-demand')); }
		assert.deepEqual(fixture.opened, [target]);
		assert.equal(await fixture.nameOptions?.validateInput?.('../escape'), 'Use 1 to 64 lowercase letters, numbers and hyphens, with a letter or number at each end.');
	});
}

test('Creating a definition rejects an existing file without changing its content', async () => {
	using fixture = new CreationFixture();
	const target = fixture.target();
	await fixture.files.createDirectory(URI.joinPath(fixture.folder, '.ash', 'agents'));
	await fixture.files.writeFileBytes(target, new TextEncoder().encode('Existing private definition.'), { create: true, overwrite: false });
	await assert.rejects(fixture.run(), /exist/iu);
	assert.equal((await fixture.files.readFile(target)).content, 'Existing private definition.');
	assert.deepEqual(fixture.opened, []);
});

test('Invalid names and invalid definition content never create a file', async () => {
	using fixture = new CreationFixture();
	fixture.name = '../escape';
	await assert.rejects(fixture.run(), /lowercase/u);
	fixture.name = 'reviewer';
	fixture.dialog = { confirmed: true, values: ['中'.repeat(342), 'Instructions'] };
	await assert.rejects(fixture.run(), /UTF-8/u);
	await assert.rejects(fixture.files.stat(fixture.target()));
	assert.deepEqual(fixture.opened, []);
});

test('Cancelling creation, disabling AI and lacking a workspace leave files untouched', async () => {
	using fixture = new CreationFixture();
	fixture.name = undefined;
	await fixture.run();
	fixture.name = 'reviewer';
	fixture.dialog = { confirmed: false };
	await fixture.run();
	fixture.disabled = true;
	const calls = fixture.nameCalls;
	await fixture.run();
	assert.equal(fixture.nameCalls, calls);
	fixture.disabled = false;
	fixture.snapshot = { id: 'empty', folders: [] };
	await fixture.run();
	assert.equal(fixture.notices.length, 1);
	await assert.rejects(fixture.files.stat(fixture.target()));
	assert.deepEqual(fixture.opened, []);
});

test('Creation rejects a late dialog response after the workspace owner changes', async () => {
	using fixture = new CreationFixture();
	const pending = new DeferredPromise<IInputDialogResult>();
	fixture.dialog = pending.p;
	const creating = fixture.run();
	await fixture.shown.p;
	fixture.snapshot = { ...fixture.snapshot, id: 'replacement' };
	await pending.complete({ confirmed: true, values: ['Review', 'Instructions'] });
	await assert.rejects(creating, isCancellationError);
	await assert.rejects(fixture.files.stat(fixture.target()));
	assert.deepEqual(fixture.opened, []);
});


suite('Definition creation browser interaction', () => {
	const browser = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		test(`keyboard creation preserves the name and reaches the file owner in ${locale}`, async () => {
			const { page } = browser;
			await page.goto(`/newPromptFileActions.html?locale=${locale}`);
			for (const kind of ['Agent', 'Instructions']) {
				await page.getByRole('button', { name: `Create ${kind}`, exact: true }).click();
				const naming = page.locator('.ash-quick-pick:visible input');
				await naming.fill('browser-reviewer');
				await naming.press('Enter');
				const dialog = page.locator('dialog[open]');
				await expect(dialog).toBeVisible();
				await dialog.getByPlaceholder(locale === 'en' ? 'Description' : '描述', { exact: true }).fill('Review project changes.');
				await dialog.getByPlaceholder(locale === 'en' ? 'Instructions' : '指令', { exact: true }).fill('Preserve the project conventions.');
				await dialog.getByRole('button', { name: locale === 'en' ? 'Create' : '创建', exact: true }).click();
				const status = page.getByRole('status');
				await expect(status).toContainText(`memory:/project/.ash/${kind === 'Agent' ? 'agents' : 'instructions'}/browser-reviewer.md`);
				await expect(status).toContainText('Preserve the project conventions.');
				if (kind === 'Instructions') await expect(status).toContainText('load: on-demand');
			}
		});
	}
});


test('Configure Custom Agents opens the existing Settings owner and respects AI disablement', async () => {
	using services = new InstantiationService();
	using registration = registerAgentActions();
	const openings: unknown[] = [];
	let disabled = false;
	services.registerInstance(IConfigurationService, { getValue: () => disabled } as unknown as IConfigurationService);
	services.registerInstance(IPreferencesService, { openSettings: async (options: unknown) => { openings.push(options); } } as unknown as IPreferencesService);
	const command = CommandsRegistry.getCommand('workbench.action.chat.configure.customagents')!;
	await services.invokeFunction(command);
	assert.deepEqual(openings, [{ section: 'agents', jsonEditor: false }]);
	disabled = true;
	await services.invokeFunction(command);
	assert.equal(openings.length, 1);
});

class AgentDraftFixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly resource = URI.file('/project/.ash/agents/reviewer.md');
	editor = { resource: this.resource };
	dirty = false;
	disabled = false;
	revision = 0;
	reads = 0;
	readonly notices: string[] = [];
	readonly openings: unknown[] = [];
	catalog = { providerId: 'remote:review-host', agents: [{ name: 'reviewer', description: 'Review code.', source: { type: 'directory', id: 'source:project' }, launch: 'any', resource: this.resource }] } as unknown as AgentRoleCatalog;
	read: () => Promise<AgentRoleCatalog> = async () => this.catalog;
	constructor() {
		super();
		this._register(registerAgentActions());
		const fixture = this;
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
		this.services.registerInstance(IEditorService, { get activeEditor() { return fixture.editor; } } as unknown as IEditorService);
		this.services.registerInstance(IWorkingCopyService, { get: () => [{ isDirty: this.dirty }] } as unknown as IWorkingCopyService);
		this.services.registerInstance(INotificationService, { info: (message: string) => this.notices.push(message) } as unknown as INotificationService);
		this.services.registerInstance(IAgentSessionService, { readRoleCatalog: () => { this.reads++; return this.read(); } } as unknown as IAgentSessionService);
		this.services.registerInstance(IChatSessionNavigationService, { get revision() { return fixture.revision; }, createNewConversation: async (options: unknown) => { this.openings.push(options); return true; } } as unknown as IChatSessionNavigationService);
	}
	async run(): Promise<void> { await this.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.newWithCurrentAgent')!); }
}

test('The current saved Agent opens an unsent source-qualified draft on its catalog host', async () => {
	using fixture = new AgentDraftFixture();
	await fixture.run();
	assert.deepEqual(fixture.openings, [{ focus: true, providerId: 'remote:review-host', agent: { name: 'reviewer', description: 'Review code.', sourceId: 'source:project' } }]);
});

test('Current Agent never reads unsaved text or starts disabled, undiscovered or restricted roles', async () => {
	using fixture = new AgentDraftFixture();
	fixture.dirty = true;
	await fixture.run();
	assert.equal(fixture.reads, 0);
	fixture.dirty = false;
	fixture.disabled = true;
	await fixture.run();
	assert.equal(fixture.reads, 0);
	fixture.disabled = false;
	const role = fixture.catalog.agents[0];
	for (const agents of [[], [{ ...role, resource: URI.file('/other/.ash/agents/reviewer.md') }], [{ ...role, launch: 'workflow' as const }]]) {
		fixture.catalog = { ...fixture.catalog, agents };
		await fixture.run();
	}
	assert.deepEqual(fixture.openings, []);
});

for (const change of ['editor', 'dirty', 'host', 'disabled'] as const) test(`A late Agent catalog cannot create a chat after ${change} changes`, async () => {
	using fixture = new AgentDraftFixture();
	const pending = new DeferredPromise<AgentRoleCatalog>();
	fixture.read = () => pending.p;
	const running = fixture.run();
	if (change === 'editor') fixture.editor = { resource: fixture.resource };
	if (change === 'dirty') fixture.dirty = true;
	if (change === 'host') fixture.revision++;
	if (change === 'disabled') fixture.disabled = true;
	await pending.complete(fixture.catalog);
	await assert.rejects(running, isCancellationError);
	assert.deepEqual(fixture.openings, []);
});


test('Save as Instructions copies the current Markdown through the native creation flow', async () => {
	using fixture = new CreationFixture();
	using source = new TextModel('Review the code.\n\n  Preserve indentation.', { resource: URI.parse('memory:/project/notes.md'), languageId: 'markdown' });
	fixture.services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => source }) } as unknown as ICodeEditorService);
	fixture.dialog = { confirmed: true, values: ['Review instructions'] };
	await fixture.run('workbench.action.chat.saveAsInstructions');
	const resource = fixture.target('instructions');
	const { content } = await fixture.files.readFile(resource);
	assert.match(content, /load: on-demand\n---\n\nReview the code.\n\n  Preserve indentation./u);
	assert.deepEqual(fixture.opened, [resource]);
	assert.equal(source.getValue(), 'Review the code.\n\n  Preserve indentation.');
});
