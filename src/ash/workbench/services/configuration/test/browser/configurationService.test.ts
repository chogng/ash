import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase, extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { TestConfigurationFiles, TestConfigurationService, TestWorkspaceService } from '../common/testServices.js';
import { ConfigurationRegistry, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { AbstractPolicyService } from '../../../../../platform/policy/common/policy.js';

test('Workspace initialization reads user settings once for migration and parsing', async () => {
	let reads = 0;
	using files = new class extends TestConfigurationFiles {
		override readFile(...args: Parameters<TestConfigurationFiles['readFile']>): ReturnType<TestConfigurationFiles['readFile']> {
			reads++;
			return super.readFile(...args);
		}
	}('{ "test.value": 42 }');
	await files.readFile(URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' }));
	reads = 0;
	using configuration = new TestConfigurationService({ files });
	await configuration.initialize(files);
	assert.equal(configuration.getValue('test.value'), 42);
	assert.equal(reads, 1);
});

test('Workspace membership preserves URI boundaries, root ranking and casing', () => {
	const rootUris = [
		'file:///project', 'file:///project/src', 'file:///project/src/',
		'file:///C:/Work', 'file:///c:/work', 'file:///C:/Work/src',
		'file://BUILD/share/Work', 'file://build/share/work/nested',
		'ash-remote://ssh+build/Work', 'ash-remote://ssh+build/Work/src',
		'ash-remote://ssh+other/Work', 'file:///%61%61%61', 'file:///aaa/b',
		'file:///trailing////////', 'file:///trailing/child',
		'ash-remote://ssh+build/repeated//root',
		'ash-remote://ssh+build/escaped/a%2Fb', 'ash-remote://ssh+build/escaped/a/b',
		'file:///decorated?root', 'file:///fragment#root',
	];
	const candidateUris = [
		'file:///project/src/file?preview#L2', 'file:///project/src-other/file',
		'file:///c:/WORK/src/file', 'file://build/share/WORK/nested/file',
		'ash-remote://ssh+build/Work/src/file', 'ash-remote://ssh+build/work/src/file',
		'ash-remote://ssh+other/Work/src/file', 'file:///aaa/b/file',
		'file:///trailing/child/file', 'file:///decorated/file', 'file:///fragment/file',
		'ash-remote://ssh+build/repeated//root/file', 'ash-remote://ssh+build/repeated/root/file',
		'ash-remote://ssh+build/escaped/a%2fb/file', 'ash-remote://ssh+build/escaped/a/b/file',
		'ash-remote://ssh+build/escaped/a%5Cb/file', 'file:///elsewhere',
	];
	const folders = rootUris.map((uri, index) => ({ id: `root-${index}`, uri: URI.parse(uri), name: `root-${index}`, index }));
	using workspace = new TestWorkspaceService({ id: 'membership', folders });
	for (const ordered of [folders, [...folders].reverse(), [...folders.slice(7), ...folders.slice(0, 7)]]) {
		workspace.updateWorkspace({ id: 'membership', folders: ordered.map((folder, index) => ({ ...folder, index })) });
		for (const source of candidateUris) {
			const resource = URI.parse(source);
			const candidate = resource.with({ query: null, fragment: null });
			// Reference the previous membership policy, including its encoded-length
			// ranking, so changing the collection cannot silently change root ownership.
			const matches = workspace.getWorkspace().folders.filter(folder => {
				const comparison = folder.uri.scheme === 'file' && (folder.uri.authority || /^\/[a-z]:($|\/)/i.test(folder.uri.path))
					? extUriIgnorePathCase : extUriBiasedIgnorePathCase;
				return comparison.isEqualOrParent(candidate, folder.uri);
			}).sort((left, right) => right.uri.toEncodedComponents().path.length - left.uri.toEncodedComponents().path.length);
			assert.equal(workspace.getWorkspaceFolder(resource), matches[0] ?? null, source);
		}
	}
});

test('Workspace membership commits its index before workspace listeners run', () => {
	using workspace = new TestWorkspaceService({ id: 'old', uri: URI.file('/old') });
	const resource = URI.file('/new/nested/file.ts');
	let notifications = 0;
	using listener = workspace.onDidChangeWorkspace(() => {
		notifications++;
		const folder = workspace.getWorkspaceFolder(resource);
		assert.equal(folder, workspace.getWorkspace().folders[1]);
		assert.equal(workspace.getWorkspaceFolder(URI.file('/old/file.ts')), null);
	});
	workspace.updateWorkspace({
		id: 'new', folders: [
			{ id: 'root', uri: URI.file('/new'), name: 'new', index: 0 },
			{ id: 'nested', uri: URI.file('/new/nested'), name: 'nested', index: 1 },
		]
	});
	assert.equal(notifications, 1);
	workspace.updateWorkspace(workspace.getWorkspace());
	assert.equal(notifications, 1);
});

test('provider settings retain JSONC, layered directory values and external changes without a Workbench schema', async () => {
	using files = new TestConfigurationFiles('{ "rust-analyzer.cargo.extraEnv": { "USER_LIB": "/user/lib" } }');
	using provider = new InMemoryFileSystemProvider();
	using registration = files.registerProvider('file', provider);
	const root = URI.file('/project');
	const first = URI.joinPath(root, 'first');
	const second = URI.joinPath(root, 'second');
	const workspaceFile = URI.joinPath(root, 'test.code-workspace');
	for (const folder of [first, second]) await files.createDirectory(URI.joinPath(folder, '.vscode'));
	await files.writeFile({ resource: workspaceFile, content: '{ "settings": { "rust-analyzer.cargo.allTargets": false } }' }, { create: true, overwrite: false });
	const settings = URI.joinPath(first, '.vscode', 'settings.json');
	await files.writeFile({ resource: settings, content: '// provider-owned settings\n{ "rust-analyzer.cargo.buildScripts.enable": false, "rust-analyzer.cargo.extraEnv": { "WORKSPACE_LIB": "/workspace/lib" }, }' }, { create: true, overwrite: false });
	using configuration = new TestConfigurationService({
		files, workspace: {
			id: 'provider-settings', configuration: workspaceFile,
			folders: [first, second].map((uri, index) => ({ uri, id: String(index), name: String(index), index })),
		}
	});
	await configuration.initialize(files);
	const firstSettings = configuration.getValue('rust-analyzer', { resource: first });
	assert.deepEqual(firstSettings, {
		cargo: { extraEnv: { USER_LIB: '/user/lib', WORKSPACE_LIB: '/workspace/lib' }, allTargets: false, buildScripts: { enable: false } },
	});
	assert.deepEqual(configuration.getValue('rust-analyzer', { resource: second }), {
		cargo: { extraEnv: { USER_LIB: '/user/lib' }, allTargets: false },
	});
	assert.equal(configuration.getValue('rust-analyzer', { resource: URI.joinPath(first, 'src', 'lib.rs') }), firstSettings);
	assert.deepEqual(configuration.getValue<{ 'rust-analyzer': unknown; }>()['rust-analyzer'], {
		cargo: { extraEnv: { USER_LIB: '/user/lib' }, allTargets: false },
	});
	let changed = false;
	using listener = configuration.onDidChangeConfiguration(event => { changed ||= event.affectsConfiguration('rust-analyzer', { resource: first }); });
	await files.writeFile({ resource: settings, content: '{}' }, { create: false, overwrite: true });
	await configuration.reloadConfiguration(configuration.getWorkspace().folders[0]!);
	assert.equal(changed, true);
	assert.deepEqual(configuration.getValue('rust-analyzer', { resource: first }), configuration.getValue('rust-analyzer', { resource: second }));
});

test('Language-scoped configuration reuses reads and follows user and policy changes', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'test.tabSize', defaultValue: 4, parse: value => value as number, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, policy: { name: 'ManagedTabSize' } });
	class Policies extends AbstractPolicyService {
		set(tabSize: number | undefined): void { this.accept(tabSize === undefined ? {} : { ManagedTabSize: tabSize }); }
		protected async refresh(): Promise<void> { }
	}
	using policies = new Policies();
	policies.set(8);
	using configuration = new TestConfigurationService({ registry, source: '{ "test.tabSize": 2, "[typescript]": { "test.tabSize": 6 } }' });
	await configuration.initialize(configuration.fileService, policies);
	const typescript = { overrideIdentifier: 'typescript', resource: URI.file('/project/a.ts') };
	const javascript = { overrideIdentifier: 'javascript', resource: URI.file('/project/b.js') };
	const previous = configuration.getValue('test', typescript);
	assert.deepEqual(previous, { tabSize: 8 });
	assert.equal(configuration.getValue('test', { ...typescript, resource: URI.file('/project/c.ts') }), previous);
	assert.equal(configuration.inspect('test.tabSize', typescript).policyValue, 8);
	assert.equal(configuration.getValue('test', javascript), configuration.getValue('test'));

	const seen: unknown[] = [];
	using listener = configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('test.tabSize', typescript)) seen.push(configuration.getValue('test', typescript));
	});
	policies.set(undefined);
	assert.deepEqual(configuration.getValue('test', typescript), { tabSize: 6 });
	assert.deepEqual(configuration.getValue('test', javascript), { tabSize: 2 });
	await configuration.write('{ "test.tabSize": 3, "[typescript]": { "test.tabSize": 7 } }');
	assert.deepEqual(configuration.getValue('test', typescript), { tabSize: 7 });
	assert.deepEqual(configuration.getValue('test', javascript), { tabSize: 3 });
	assert.deepEqual(previous, { tabSize: 8 });
	assert.deepEqual(seen, [{ tabSize: 6 }, { tabSize: 7 }]);
});
