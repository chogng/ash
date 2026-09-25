import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileKind, type IFileService } from '../../../../../platform/files/common/files.js';
import { ExplorerFileNestingSettingId, ExplorerFileNestingTrie } from '../../common/explorerFileNestingTrie.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { ExplorerDataSource, FileSorter } from '../../browser/views/explorerViewer.js';

test('Explorer file nesting resolves captures, transitive children, and cycles', () => {
	const nesting = new ExplorerFileNestingTrie([
		['*.ts', ['${capture}.js', '${capture}.d.ts']],
		['*.js', ['${capture}.js.map', '${capture}.ts']],
	]);
	const result = nesting.nest(['app.ts', 'app.js', 'app.js.map', 'app.d.ts', 'readme.md'], 'src');
	assert.deepEqual(Object.fromEntries([...result].map(([parent, children]) => [parent, [...children]])), {
		'app.ts': ['app.js', 'app.js.map', 'app.d.ts'],
		'readme.md': [],
	});

	const substitutions = new ExplorerFileNestingTrie([['package.json', ['${dirname}.lock', '${basename}.${extname}.bak']]]);
	assert.deepEqual([...substitutions.nest(['package.json', 'src.lock', 'package.json.bak'], 'src').get('package.json') ?? []], ['src.lock', 'package.json.bak']);
});

test('Explorer data source nests configured files and keeps folders separate', async () => {
	const folder = URI.file('C:\\project');
	const fileService = {
		readDirectory: async () => ['src', 'app.js', 'app.ts', 'readme.md'].map(name => ({
			name,
			resource: URI.file(`C:\\project\\${name}`),
			kind: name === 'src' ? FileKind.Directory : FileKind.File,
		})),
	} as unknown as IFileService;
	let enabled = true;
	const configuration = {
		getValue: (key: string) => key === ExplorerFileNestingSettingId.Enabled ? enabled : { '*.ts': '${capture}.js' },
	} as IConfigurationService;
	const source = new ExplorerDataSource(fileService, new FileSorter(), configuration);
	const root = new ExplorerItem(folder, 'project', FileKind.Directory);

	const nested = await source.getChildren(root);
	assert.deepEqual(nested.map(item => [item.name, item.children?.map(child => child.name) ?? []]), [
		['src', []],
		['app.ts', ['app.js']],
		['readme.md', []],
	]);
	assert.equal(source.hasChildren(nested[1]!), true);
	assert.deepEqual((await source.getChildren(nested[1]!)).map(item => item.name), ['app.js']);

	enabled = false;
	assert.deepEqual((await source.getChildren(root)).map(item => item.name), ['src', 'app.js', 'app.ts', 'readme.md']);
});
