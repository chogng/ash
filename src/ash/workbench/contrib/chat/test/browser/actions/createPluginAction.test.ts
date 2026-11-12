import { languagePackCatalog as chineseCatalog } from '../../../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, test } from 'mocha';
import { Disposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { commandActionLabel } from '../../../../../../platform/action/common/action.js';
import { MenuId, MenusRegistry } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IInputOptions } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { registerCreatePluginAction } from '../../../browser/actions/createPluginAction.js';

const id = 'workbench.action.chat.createPlugin';
const root = URI.parse('memory:/workspace');
const chinese = chineseCatalog.bundles;

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly files = this._register(new FileService());
	readonly provider = this._register(new InMemoryFileSystemProvider());
	readonly prompts: IInputOptions[] = [];
	readonly opened: URI[] = [];
	answers: Array<string | undefined> = ['acme/review-plugin', 'source'];
	disabled = false;
	revision = 0;
	constructor() {
		super();
		this._register(this.files.registerProvider('memory', this.provider));
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
		this.services.registerInstance(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ id: 'workspace', name: 'Workspace', uri: root, index: 0 }] }) } as unknown as IWorkspaceContextService);
		this.services.registerInstance(IQuickInputService, { input: async (options: IInputOptions) => { this.prompts.push(options); return this.answers.shift(); } } as unknown as IQuickInputService);
		const fixture = this;
		this.services.registerInstance(IChatSessionNavigationService, { get revision() { return fixture.revision; } } as unknown as IChatSessionNavigationService);
		this.services.registerInstance(IEditorService, { activeEditor: undefined, openEditor: async (input: { resource: URI; }) => { this.opened.push(input.resource); } } as unknown as IEditorService);
	}
	async prepare(): Promise<void> {
		await this.files.createDirectory(URI.joinPath(root, 'source', 'references'));
		await this.files.writeFile({ resource: URI.joinPath(root, 'source', 'SKILL.md'), content: '---\nname: code-review\ndescription: Review code\n---\nRead references/checks.md.\n' }, { create: true, overwrite: false });
		await this.files.writeFileBytes(URI.joinPath(root, 'source', 'references', 'checks.md'), new Uint8Array([0, 1, 255]));
	}
	async run(): Promise<void> { await this.services.invokeFunction(CommandsRegistry.getCommand(id)!); }
}

suite('Create Ash plugin from Skill', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let registrations: IDisposable;
	suiteSetup(() => {
		setNlsMessages('zh-CN', chinese);
		try { registrations = registerCreatePluginAction(); } finally { resetNlsResolver(); }
	});
	// The registry is process-scoped; the tests also verify explicit teardown.
	test('the real command copies a complete Skill and publishes an installable manifest', async () => {
		using f = new Fixture(); await f.prepare(); await f.run();
		const manifest = URI.joinPath(root, 'review-plugin', '.ash-plugin', 'plugin.json');
		assert.deepEqual(JSON.parse((await f.files.readFile(manifest)).content), {
			schemaVersion: 1, id: 'acme/review-plugin', version: '0.1.0', displayName: 'review-plugin',
			compatibility: { ash: '>=0.1.0' }, permissions: [],
			contributions: { skills: [{ id: 'review-plugin', path: 'skills/review-plugin' }] },
		});
		assert.deepEqual((await f.files.readFileBytes(URI.joinPath(root, 'review-plugin', 'skills', 'review-plugin', 'references', 'checks.md'))).bytes, new Uint8Array([0, 1, 255]));
		assert.equal((await f.files.readFile(URI.joinPath(root, 'source', 'SKILL.md'))).content.includes('Read references/checks.md.'), true);
		assert.deepEqual(f.opened.map(uri => uri.toString()), [manifest.toString()]);
		assert.deepEqual((await f.files.readDirectory(root)).map(entry => entry.name).sort(), ['review-plugin', 'source']);
	});

	for (const answers of [[undefined], ['acme/review-plugin', undefined]]) test('cancelling creation leaves no package or temporary folder: ' + answers.length, async () => {
		using f = new Fixture(); await f.prepare(); f.answers = answers;
		await f.run();
		assert.deepEqual((await f.files.readDirectory(root)).map(entry => entry.name), ['source']);
		assert.deepEqual(f.opened, []);
	});

	test('a destination collision preserves existing bytes and removes only this attempt staging', async () => {
		using f = new Fixture(); await f.prepare();
		await f.files.createDirectory(URI.joinPath(root, 'review-plugin'));
		const existing = URI.joinPath(root, 'review-plugin', 'keep.txt');
		await f.files.writeFile({ resource: existing, content: 'Keep original package' }, { create: true, overwrite: false });
		await assert.rejects(f.run());
		assert.equal((await f.files.readFile(existing)).content, 'Keep original package');
		assert.deepEqual((await f.files.readDirectory(root)).map(entry => entry.name).sort(), ['review-plugin', 'source']);
		assert.deepEqual(f.opened, []);
	});

	test('copy failures leave the source and remove the unfinished package', async () => {
		using f = new Fixture(); await f.prepare();
		f.provider.copy = async () => { throw new Error('Source became unavailable'); };
		await assert.rejects(f.run(), /Source became unavailable/u);
		assert.deepEqual((await f.files.readDirectory(root)).map(entry => entry.name), ['source']);
	});

	test('a completed copy cannot steal editor focus after conversation navigation', async () => {
		using f = new Fixture(); await f.prepare();
		const copy = f.provider.copy.bind(f.provider);
		f.provider.copy = async (source, target) => { await copy(source, target); f.revision++; };
		await f.run();
		assert.deepEqual(f.opened, []);
		assert.ok(await f.files.stat(URI.joinPath(root, 'review-plugin', '.ash-plugin', 'plugin.json')));
	});

	test('AI disablement does not request paths or write files', async () => {
		using f = new Fixture(); f.disabled = true; await f.run();
		assert.deepEqual(f.prompts, []);
	});

	test('Chinese UI validates identifiers and relative paths at input', async () => {
		using f = new Fixture(); await f.prepare();
		setNlsMessages('zh-CN', chinese);
		try {
			await f.run();
			assert.equal(f.prompts[0].title, '插件标识符');
			assert.match((await f.prompts[0].validateInput!('../escape'))!, /publisher\/plugin-name/u);
			for (const path of ['../escape', '/absolute', 'nested//folder', 'nested\\folder', '.']) assert.match((await f.prompts[1].validateInput!(path))!, /工作区/u);
			assert.equal(await f.prompts[1].validateInput!('.ash/skills/review'), undefined);
		} finally { resetNlsResolver(); }
		const command = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === id);
		assert.ok(command && 'command' in command);
		assert.equal(commandActionLabel(command.command.title), '从 Skill 创建插件…');
	});

	test('explicit registration lifetime removes the command', () => {
		registrations.dispose();
		assert.equal(CommandsRegistry.getCommand(id), undefined);
	});
});
