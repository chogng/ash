import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { match } from '../../../../../base/common/glob.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService, FileKind } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type EditorOpenTarget } from '../../../../services/editor/common/editorService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { splitGlobPatterns } from '../../../../services/search/common/queryBuilder.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { SearchResultImpl } from '../../../search/browser/searchTreeModel/searchResult.js';
import { parseSearchEditor, searchEditorLocation, serializeSearchResultForEditor } from '../../browser/searchEditorSerialization.js';
import { OpenNewEditorCommandId, SearchEditorID } from '../../browser/constants.js';
import '../../browser/searchEditor.contribution.js';

test('the Search Editor command scopes folder search to its workspace root and literal path', async () => {
	using services = new InstantiationService();
	using commands = new CommandService(services);
	const root = URI.file('/workspace/one');
	const folder = URI.joinPath(root, 'src,[fixture]');
	services.registerInstance(IWorkspaceContextService, {
		getWorkspaceFolder: () => ({ uri: root, id: 'one', index: 0, name: 'one' }),
	} as unknown as IWorkspaceContextService);
	services.registerInstance(IFileService, {
		stat: async () => ({ kind: FileKind.Directory }),
	} as unknown as IFileService);
	let opened: IResourceEditorInput | undefined;
	let destination: EditorOpenTarget | undefined;
	services.registerInstance(IEditorService, {
		openEditor: async (input: IResourceEditorInput, _options: unknown, target?: EditorOpenTarget) => {
			opened = input;
			destination = target;
		},
	} as IEditorService);
	await commands.executeCommand(OpenNewEditorCommandId, { folder, groupId: 42 });
	assert.equal(opened?.editorId, SearchEditorID);
	assert.deepEqual(destination, { groupId: 42 });
	const query = parseSearchEditor(opened!.initialText!);
	assert.equal(query.workspaceRoot, root.toString());
	const [pattern] = query.includePatterns;
	assert.ok(match(pattern!, 'src,[fixture]/match.txt'));
	assert.ok(!match(pattern!, 'src,fixture/match.txt'));
	assert.deepEqual(splitGlobPatterns(query.includePatterns.join(', ')), query.includePatterns);
});

test('saved search documents restore multiline queries, filters and exact source ranges across roots', () => {
	const query = { text: 'first\nsecond', patternKind: 'literal' as const, caseSensitivity: 'smart' as const, wholeWord: true, includePatterns: ['src/**'], excludePatterns: ['**/*.test.ts'], maxResults: 100, freshness: 'current' as const };
	const results = new SearchResultImpl([{ id: 'one', index: 0, name: 'one', uri: URI.file('/workspace') }, { id: 'two', index: 1, name: 'two', uri: URI.parse('ssh://server/workspace') }]);
	results.add([
		{ dirId: 'one', path: 'src/main.ts', lineNumber: 4, preview: '中文😀 first\r\nsecond end', ranges: [{ start: 5, end: 18 }] },
		{ dirId: 'two', path: 'src/main.ts', lineNumber: 2, preview: 'first\nsecond', ranges: [{ start: 0, end: 12 }] },
	]);
	const text = serializeSearchResultForEditor(query, results);
	assert.deepEqual(parseSearchEditor(text), query);
	assert.deepEqual(searchEditorLocation(text, 4), { resource: URI.file('/workspace/src/main.ts'), range: new Range(4, 6, 5, 7) });
	assert.deepEqual(searchEditorLocation(text, 7), { resource: URI.parse('ssh://server/workspace/src/main.ts'), range: new Range(2, 1, 3, 7) });
	assert.equal(searchEditorLocation(text, 1), undefined);
	assert.match(text, /first ↵ second/);
});

test('edited search documents reject invalid headers and read edited source positions', () => {
	assert.throws(() => parseSearchEditor('results without a header'), TypeError);
	assert.throws(() => parseSearchEditor('# Search: {"version":1,"query":{"text":4}}'), TypeError);
	const text = '# File: file:///workspace/main.ts\n  8:2-9:4: edited\n  9:4-8:2: invalid';
	assert.deepEqual(searchEditorLocation(text, 2), { resource: URI.file('/workspace/main.ts'), range: new Range(8, 2, 9, 4) });
	assert.equal(searchEditorLocation(text, 3), undefined);
});


test('search documents retain untitled and outside-workspace URI identity and UTF-16 positions', () => {
	const query = { text: 'needle', patternKind: 'literal' as const, caseSensitivity: 'sensitive' as const, includePatterns: [], excludePatterns: [], maxResults: 100, freshness: 'current' as const };
	const results = new SearchResultImpl([]);
	for (const resource of [URI.parse('untitled:/Untitled-1'), URI.file('/outside/main.ts')]) {
		results.addFileMatch({ resource, results: [{ previewText: '中文😀 needle', rangeLocations: [{ source: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 11 }, preview: { startLineNumber: 0, startColumn: 5, endLineNumber: 0, endColumn: 11 } }] }] });
	}
	const text = serializeSearchResultForEditor(query, results);
	assert.deepEqual(searchEditorLocation(text, 4), { resource: URI.parse('untitled:/Untitled-1'), range: new Range(4, 6, 4, 12) });
	assert.deepEqual(searchEditorLocation(text, 7), { resource: URI.file('/outside/main.ts'), range: new Range(4, 6, 4, 12) });
});
