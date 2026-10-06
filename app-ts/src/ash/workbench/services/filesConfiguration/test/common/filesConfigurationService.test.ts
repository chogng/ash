import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { setNlsMessages } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { FilesConfigurationService } from '../../common/filesConfigurationService.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { TextFileService } from '../../../textfile/common/textFileService.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { Event } from '../../../../../base/common/event.js';
import { languagePackCatalog } from '../../../localization/common/localizationCatalog.zh-CN.js';

suite('Configured file policies', () => {
	test('applies writable exceptions, retains filesystem read-only and announces changes', async () => {
		using configuration = new InMemoryConfigurationService();
		using workspace = new WorkspaceContextService({ id: 'root', uri: URI.file('/root') });
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IWorkspaceContextService, workspace);
		using policy = services.createInstance(FilesConfigurationService);
		let changes = 0;
		using listener = policy.onDidChangeReadonly(() => changes++);
		await configuration.updateValue('files.readonlyInclude', { 'generated/**': true });
		await configuration.updateValue('files.readonlyExclude', { 'generated/keep.ts': true });
		const writable = URI.file('/root/generated/keep.ts');
		assert.deepEqual([
			!!policy.isReadonly(URI.file('/root/generated/main.ts')),
			policy.isReadonly(writable),
			policy.isReadonly(writable, { resource: writable, kind: FileKind.File, sizeBytes: 1, readonly: true, modifiedAtMillis: 0 }),
			changes,
		], [true, false, true, 2]);
	});

	test('rejects malformed persisted rules before notifying consumers', async () => {
		using configuration = new InMemoryConfigurationService();
		await assert.rejects(configuration.updateValue('files.readonlyInclude', { '**/*': { when: 3 } }), /Invalid rule/);
		await assert.rejects(configuration.updateValue('files.readonlyInclude', { '**/*': { when: 'main.ts' } }), /Use true or false/);
		assert.deepEqual(configuration.getValue('files.readonlyInclude'), {});
	});

	test('blocks the actual save service and publishes only completed writes', async () => {
		using configuration = new InMemoryConfigurationService();
		using workspace = new WorkspaceContextService({ id: 'root', uri: URI.file('/root') });
		using policy = new FilesConfigurationService(configuration, workspace);
		const resource = URI.file('/root/main.ts');
		let writes = 0;
		const files = { onDidChangeFiles: Event.None, readFile: async () => undefined, writeFile: async () => { writes++; return { revision: 'saved' }; } } as unknown as IFileService;
		using textFiles = new TextFileService(files, policy);
		const saved: string[] = [];
		using listener = textFiles.onDidSave(event => saved.push(event.content));
		await configuration.updateValue('files.readonlyInclude', { '**/*.ts': true });
		await assert.rejects(textFiles.save({ resource, text: 'blocked' }, new AbortController().signal), /read-only/);
		await configuration.updateValue('files.readonlyExclude', { '**/main.ts': true });
		await textFiles.save({ resource, text: 'accepted', encoding: 'utf8bom' }, new AbortController().signal);
		assert.deepEqual([writes, saved], [1, ['\uFEFFaccepted']]);
	});

	test('uses the shipped Chinese catalog for read-only explanations', async () => {
		using configuration = new InMemoryConfigurationService();
		using workspace = new WorkspaceContextService({ id: 'root', uri: URI.file('/root') });
		using policy = new FilesConfigurationService(configuration, workspace);
		await configuration.updateValue('files.readonlyInclude', { '**/*.ts': true });
		setNlsMessages('zh-CN', languagePackCatalog.bundles);
		try {
			assert.equal(policy.isReadonly(URI.file('/root/main.ts')), '该文件匹配了只读路径规则，不能编辑或保存。');
		} finally {
			setNlsMessages('en', {});
		}
	});
});
