import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { FileKind, type IFileService } from '../../../../../platform/files/common/files.js';
import { ExplorerFileNestingSettingId } from '../../common/explorerFileNestingTrie.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { ExplorerDataSource, FileSorter } from '../../browser/views/explorerViewer.js';

test('Explorer model groups generated files and keeps directories as separate roots', async () => {
	const root = URI.file('C:\\project');
	const entries = [
		{ resource: URI.file('C:\\project\\main.ts'), name: 'main.ts', kind: FileKind.File },
		{ resource: URI.file('C:\\project\\main.js'), name: 'main.js', kind: FileKind.File },
		{ resource: URI.file('C:\\project\\src'), name: 'src', kind: FileKind.Directory },
	];
	const files = { readDirectory: async () => entries } as unknown as IFileService;
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: ExplorerFileNestingSettingId.Enabled, defaultValue: false, parse: value => Boolean(value) });
	registry.registerConfiguration({ key: ExplorerFileNestingSettingId.Patterns, defaultValue: {}, parse: value => value as Record<string, string> });
	using configuration = new InMemoryConfigurationService(registry);
	await configuration.updateValue(ExplorerFileNestingSettingId.Enabled, true);
	await configuration.updateValue(ExplorerFileNestingSettingId.Patterns, { '*.ts': '${capture}.js' });
	const source = new ExplorerDataSource(files, new FileSorter(), configuration);
	const children = await source.getChildren(new ExplorerItem(root, 'project', FileKind.Directory));
	assert.deepEqual(children.map(item => item.name), ['src', 'main.ts']);
	assert.deepEqual(children[1]?.children?.map(item => item.name), ['main.js']);
	assert.equal(children[1]?.children?.[0]?.resource.toString(), entries[1]?.resource.toString());
});
