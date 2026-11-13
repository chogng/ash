import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { match } from '../../../../../base/common/glob.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService, FileKind } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type EditorOpenTarget } from '../../../../services/editor/common/editorService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { splitGlobPatterns } from '../../../../services/search/common/queryBuilder.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { EditorPanes } from '../../../../browser/editor.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../../browser/parts/editor/textResourceEditor.js';
import { BrowserEditorService } from '../../../../services/editor/browser/browserEditorService.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService, type ITextResourceStore } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { SearchResultImpl } from '../../../search/browser/searchTreeModel/searchResult.js';
import { parseSearchEditor, searchEditorLocation, serializeSearchResultForEditor } from '../../browser/searchEditorSerialization.js';
import { OpenNewEditorCommandId, SearchEditorID } from '../../browser/constants.js';
import { SearchEditor } from '../../browser/searchEditor.js';
import '../../browser/searchEditor.contribution.js';

test('the Search Editor command scopes folder search to its workspace root and literal path', async () => {
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	services.registerInstance(IContextKeyService, contexts);
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

test('generated Search Editor content stays clean, while manual edits and saved searches use file semantics', async () => {
	const { window } = browserEnvironment;
	const container = window.document.createElement('div');
	window.document.body.append(container);
	using attached = toDisposable(() => container.remove());
	using defaults = createTestEditorServices(undefined, undefined, window.document);
	using services = defaults.createChild();
	const files = new Map<string, string>();
	const resourceStore: ITextResourceStore = {
		onDidChange: Event.None,
		resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? files.get(request.resource.toString()) ?? '', revision: undefined }),
		save: async request => {
			files.set(request.resource.toString(), request.text);
			return { revision: '1' };
		},
	};
	using models = services.createInstance(BrowserTextModelService, resourceStore, {});
	services.registerInstance(IFileTextModelService, models);
	services.registerInstance(ITextModelResourceService, models);
	const workingCopies = services.get(IWorkingCopyService);
	const savedResource = URI.file('/fixture/needle.code-search');
	const prompts: Array<readonly (string | URI)[]> = [];
	const fileDialogs = {
		pickFileToSave: async (suggestion: URI) => {
			assert.equal(suggestion.path, '/Search.code-search');
			return savedResource;
		},
		showSaveConfirm: async (labels: readonly (string | URI)[]) => {
			prompts.push(labels);
			return ConfirmResult.DONT_SAVE;
		},
	} as IFileDialogService;
	services.registerInstance(IFileDialogService, fileDialogs);
	services.registerInstance(IDialogService, {} as IDialogService);
	services.registerInstance(ISearchService, {
		registerSearchResultProvider: () => { throw new Error('Unexpected provider registration'); },
		fileSearch: async () => { throw new Error('Unexpected file search'); },
		textSearch: async (query, _token, progress) => {
			const previewText = query.contentPattern.pattern;
			const range = { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: previewText.length };
			progress?.({ resource: URI.file('/fixture/example.txt'), results: [{ previewText, rangeLocations: [{ source: range, preview: range }] }] });
			return { results: [], messages: [] };
		},
	});
	using code = EditorPanes.registerEditorPane({
		id: CODE_EDITOR_ID, name: 'Text editor', canOpen: () => EditorPaneMatch.Builtin,
		create: () => services.createInstance(TextResourceEditor, resourceStore, {
			workingCopyService: workingCopies,
			createPart: createTestCodeEditor,
		}),
	});
	using part = services.createInstance(EditorPart, container, { fileDialogService: fileDialogs, workingCopyService: workingCopies });
	using editors = new BrowserEditorService(part);
	services.registerInstance(IEditorService, editors);
	services.registerInstance(IEditorPartsService, {
		groups: part.groups,
		replaceEditorResource: async (group, input, replacement) => { await group.replaceEditor(input, replacement); },
	} as IEditorPartsService);
	using commands = new CommandService(services);

	const openSearch = async (): Promise<SearchEditor> => {
		await commands.executeCommand(OpenNewEditorCommandId);
		const pane = part.activePane;
		assert.ok(pane instanceof SearchEditor);
		return pane;
	};
	const runSearch = async (pane: SearchEditor, value: string): Promise<void> => {
		const query = pane.domNode.querySelector('textarea')!;
		query.value = value;
		query.dispatchEvent(new window.Event('input', { bubbles: true }));
		assert.equal(pane.workingCopy?.isDirty, pane.workingCopy?.resource.scheme === 'file');
		const results = new Promise<void>(resolve => Event.once(pane.getControl()!.onDidChangeModelContent)(() => resolve()));
		pane.domNode.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
		await results;
		assert.match(pane.getControl()!.getValue(), /example\.txt/);
	};

	let pane = await openSearch();
	assert.equal(pane.workingCopy?.isDirty, false);
	await runSearch(pane, 'needle');
	assert.equal(pane.workingCopy?.isDirty, false);
	assert.equal(await part.activeGroup.closeEditor(part.activeInput!), true);
	assert.deepEqual(prompts, []);

	pane = await openSearch();
	await runSearch(pane, 'needle');
	const control = pane.getControl()!;
	control.executeEdits('test', [{ range: new Range(2, 1, 2, 1), text: 'Manual note' }]);
	assert.equal(pane.workingCopy?.isDirty, true);
	assert.equal(await part.activeGroup.closeEditor(part.activeInput!), true);
	assert.deepEqual(prompts, [['Search Editor']]);

	pane = await openSearch();
	await runSearch(pane, 'needle');
	await part.saveActiveEditor();
	assert.equal(part.activeInput?.resource.toString(), savedResource.toString());
	assert.match(files.get(savedResource.toString())!, /example\.txt/);
	pane = part.activePane as SearchEditor;
	assert.equal(pane.workingCopy?.isDirty, false);
	await runSearch(pane, 'new needle');
	assert.equal(pane.workingCopy?.isDirty, true);
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
