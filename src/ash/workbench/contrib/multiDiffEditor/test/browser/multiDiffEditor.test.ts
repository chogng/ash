import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { noFileIconTheme } from '../../../../../platform/theme/common/themeService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import type { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { MultiDiffEditorOptions } from '../../browser/multiDiffEditor.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { validateJsonValue } from '../../../../../base/common/jsonValue.js';
import assert from 'node:assert/strict';
import { test, suite, suiteSetup, suiteTeardown } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { JSDOM } from 'jsdom';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';
import { type CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../../../editor/common/model.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';

import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { TextFileBinaryError, TextFileContentSource, type ResolvedTextFileContent, type TextFileResolveRequest } from '../../../../services/textfile/common/textFileService.js';
import { type ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { VIEW_ID } from '../../../files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService, type IMultiDiffSourceResolver } from '../../browser/multiDiffSourceResolverService.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { EditorLineWrapping, EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { type ITextModelResourceService, type TextModelInput, type TextModelReference } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

const browserEnvironment = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { BrowserTextModelService } = await import('../../../../services/textmodelResolver/browser/browserTextModelService.js');
const { BrowserTextResourceStore } = await import('../../../codeEditor/browser/browserTextResourceStore.js');
const { createMultiDiffEditorInput } = await import('../../browser/multiDiffEditorInput.js');
const { MultiDiffEditor, MultiDiffEditorAllCollapsed } = await import('../../browser/multiDiffEditor.js');
await import('../../../codeEditor/browser/toggleWordWrap.js');
await import('../../../../../editor/browser/widget/diffEditor/commands.js');
await import('../../../../../editor/contrib/diffEditorBreadcrumbs/browser/contribution.js');
const { MultiDiffGoToFileAction } = await import('../../browser/multiDiffEditorActions.js');

function registerMultiDiffTestServices(services: InstantiationService): InstantiationService {
	if (!services.has(IResourceIconRenderer))
		services.registerInstance(IResourceIconRenderer, {
			onDidChangeResourceIcons: Event.None,
			getFileIconTheme: () => noFileIconTheme,
			renderFileIcon() {},
		});
	if (!services.has(ICommandService)) services.registerSingleton(ICommandService, () => new CommandService(services));
	if (!services.has(IUriIdentityService)) services.registerInstance(IUriIdentityService, uriIdentityServices.get(IUriIdentityService));
	if (!services.has(IWorkingCopyService)) services.registerSingleton(IWorkingCopyService, () => uriIdentityServices.createInstance(BrowserWorkingCopyService));
	services.registerSingleton(
		IStorageService,
		() =>
			new BrowserStorageService({
				ownerWindow: browserEnvironment.window as unknown as Window,
				workspaceId: 'multi-diff-tests',
				backend: browserEnvironment.window.localStorage,
				flushInterval: 0,
			}),
	);
	return services;
}

function registerDialogs(services: InstantiationService, owner: DisposableStore, sourceResolver?: IMultiDiffSourceResolver): void {
	services.registerInstance(IDialogService, {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => {
			throw new Error('Unexpected about dialog');
		},
		showMessage: async () => {},
		info: async () => {},
		warn: async () => {},
		error: async () => {},
		confirm: async () => ({ confirmed: true }),
		prompt: async () => {
			throw new Error('Unexpected prompt');
		},
		input: async () => ({ confirmed: false }),
	});
	const resolvers = owner.add(new MultiDiffSourceResolverService());
	if (sourceResolver) owner.add(resolvers.registerResolver(sourceResolver));
	services.registerInstance(IMultiDiffSourceResolverService, resolvers);
}

test('Stanza multi-diff pane resolves visible comparisons and releases the complete session', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using contexts = new ContextKeyService();
	const gitActions: string[] = [];
	using stageCommand = CommandsRegistry.register('test.stage', (_accessor, path) => {
		gitActions.push(`stage:${path}`);
	});
	using discardCommand = CommandsRegistry.register('test.discard', (_accessor, path) => {
		gitActions.push(`discard:${path}`);
	});
	const opened: string[] = [];
	const focusedViews: string[] = [];
	const contextMenus: string[][] = [];
	const committedChangeSets: string[] = [];
	const externalSourceResolver: IMultiDiffSourceResolver = {
		canHandleUri: uri => uri.path === '/test',
		resolveDiffSource: async () => {
			throw new Error('Unexpected external multi-diff source');
		},
		sourceActions: () => [
			...['Current Turn', 'Current Turn and Earlier', 'Previous Turn'].map((label, index) => ({
				id: `external.${index}`,
				label,
				tooltip: label,
				enabled: true,
				run: () => {},
			})),
		],
		primaryRepositoryAction: input =>
			input.source?.kind === 'external'
				? {
						id: 'external.commit',
						label: 'Commit',
						tooltip: 'Commit',
						enabled: true,
						run: () => {
							committedChangeSets.push('change-1');
						},
					}
				: undefined,
	};
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	registerDialogs(services, editorServices, externalSourceResolver);
	using commands = new CommandService(services);
	const menus = new MenuService(commands, contexts);
	using fileAction = registerAction2(MultiDiffGoToFileAction);
	services.registerInstance(IEditorService, {
		openEditor: async (input: IResourceEditorInput) => {
			opened.push(input.resource.toString());
		},
	} as IEditorService);
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, {
		overrideIdentifier: 'typescript',
	});
	const seenOptions: boolean[] = [];
	const seenLimits: number[] = [];
	const pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: models,
		createComputationService: () =>
			new PaneTestDiffComputationService(options => {
				seenOptions.push(options.ignoreTrimWhitespace);
				seenLimits.push(options.maxComputationTimeMs);
			}),
		lineHeight: 24,
		showLineNumbers: false,

		editorService: {
			openEditor: async (input: IResourceEditorInput) => {
				opened.push(input.resource.toString());
			},
		} as unknown as IEditorService,
		viewsService: {
			openView: async () => undefined,
			focusView: async (viewId: string) => {
				focusedViews.push(viewId);
				return true;
			},
			getViewWithId: () => null,
		} as unknown as IViewsService,
		fileActions: {
			menuService: menus,
			contextMenuProvider: {
				showContextMenu(options) {
					contextMenus.push(options.getActions().map(action => action.label));
				},
			},
			contextKeyService: contexts,
		},
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 640, height: 480 });
	await pane.setInput(
		createMultiDiffEditorInput(
			URI.parse('ash-multi-diff:/test'),
			[
				{
					label: 'src/first.ts',
					original: { resource: URI.parse('git-change:/first/original'), initialText: 'old', label: 'HEAD' },
					modified: {
						resource: URI.parse('git-change:/first/modified'),
						initialText: 'new',
						languageId: 'typescript',
						label: 'Working Tree',
						readOnly: true,
					},
					goToFile: { resource: URI.parse('file:///workspace/src/first.ts') },
					id: 'src/first.ts',
					actions: [
						{
							id: 'test.stage',
							label: 'Stage Changes',
							tooltip: 'Stage Changes',
							icon: 'check',
							command: 'test.stage',
							arguments: ['src/first.ts'],
						},
						{
							id: 'test.discard',
							label: 'Discard Changes',
							tooltip: 'Discard Changes',
							icon: 'discard',
							command: 'test.discard',
							arguments: ['src/first.ts'],
						},
					],
				},
				{
					label: 'src/second.ts',
					original: {
						resource: URI.parse('git-change:/second/original'),
						initialText: 'before',
						label: 'HEAD',
					},
					modified: {
						resource: URI.parse('git-change:/second/modified'),
						initialText: 'after',
						languageId: 'javascript',
						label: 'Working Tree',
					},
				},
			],
			'Review changes',
			{
				kind: 'external',
				providerId: 'sessions.turn',
				label: 'Current Turn',
				repositoryId: 'repo',
				branchName: 'feature/turn-preview',
			},
		),
		new AbortController().signal,
	);
	assert.deepEqual(seenOptions, [false, true]);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false);
	assert.deepEqual(seenOptions, [false, true, false]);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, true, {
		overrideIdentifier: 'typescript',
	});
	assert.deepEqual(seenOptions, [false, true, false, true]);
	await configuration.updateValue(CodeEditorConfiguration.diffMaxComputationTime, 25, {
		overrideIdentifier: 'javascript',
	});
	assert.deepEqual(seenLimits, [5_000, 5_000, 5_000, 5_000, 25]);

	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-pane').length, 1);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session.pending').length, 0);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-section').length, 2);
	assert.equal(pane.getActiveDiffItem()?.label, 'src/first.ts');
	assert.ok(pane.getControl());
	pane.focus();
	const activeControl = pane.getControl();
	assert.equal(activeControl?.modifiedEditor.getModel()?.getValue(), 'new');
	parent.tabIndex = 0;
	parent.focus();
	assert.equal(pane.getControl(), activeControl);
	pane.focus();
	assert.equal(pane.getControl(), activeControl);
	await configuration.updateValue(CodeEditorConfiguration.fontSize, 19);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Courier New');
	await configuration.updateValue(CodeEditorConfiguration.fontLigatures, true);
	for (const editor of services.get(ICodeEditorService).listCodeEditors()) {
		assert.equal(editor.getOption(EditorOption.fontInfo).fontSize, 19);
		assert.equal(editor.getOption(EditorOption.fontInfo).fontFamily, 'Courier New');
		assert.equal(editor.getOption(EditorOption.lineHeight), 24);
	}
	assert.equal(pane.getControl(), activeControl);
	assert.deepEqual(
		services
			.get(ICodeEditorService)
			.listCodeEditors()
			.map(editor => editor.getOption(EditorOption.readOnly)),
		[true, true, true, false],
	);
	assert.deepEqual(
		services
			.get(ICodeEditorService)
			.listCodeEditors()
			.map(editor => editor.getOption(EditorOption.scrollBeyondLastLine)),
		[false, false, false, false],
	);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-file-actions > .ash-toolbar').length, 2);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-toolbar').length, 1);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-toolbar .ash-dropdown-with-primary-action-view-item').length, 1);
	assert.equal(parent.querySelectorAll('button button').length, 0);
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Files"]').click();
	assert.equal(focusedViews.at(-1), VIEW_ID);
	requiredElement<HTMLButtonElement>(dom.window.document, '.stanza-multi-diff-editor-source-toolbar .ash-dropdown-with-primary-dropdown button').click();
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-repository-toolbar .ash-dropdown-with-primary-dropdown'), null);
	requiredElement<HTMLButtonElement>(parent, '.stanza-multi-diff-editor-repository-toolbar .ash-toolbar-more-actions button').click();
	assert.deepEqual(contextMenus, [['Current Turn', 'Current Turn and Earlier', 'Previous Turn'], ['Collapse All']]);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-repository-toolbar .ash-toolbar-more-actions').length, 1);
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Commit"]').click();
	assert.equal(parent.querySelector('.stanza-multi-diff-editor')?.getAttribute('aria-label'), 'Review changes, 2 files');
	assert.equal(parent.querySelector('.stanza-multi-diff-editor')?.classList.contains('hide-line-numbers'), true);
	pane.focus();
	assert.equal(requiredElement<HTMLElement>(parent, '.stanza-multi-diff-editor').contains(dom.window.document.activeElement), true);
	assert.equal(pane.viewStateTypeId, 'ash.multiDiffEditor');
	const paneViewState: unknown = validateJsonValue(pane.saveViewState());
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), false);
	pane.toggleCollapseAll();
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), true);
	const collapsedState = pane.saveViewState();
	requiredElement<HTMLButtonElement>(parent, '.stanza-multi-diff-editor-header-toggle').click();
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), false);
	pane.toggleCollapseAll();
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), true);
	pane.toggleCollapseAll();
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), false);
	pane.restoreViewState(collapsedState);
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), true);
	pane.setVisible(false);
	pane.expandAll();
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), true, 'A retained hidden pane must not change title context');
	pane.setVisible(true);
	assert.equal(contexts.getValue(MultiDiffEditorAllCollapsed.key), false);
	pane.restoreViewState(paneViewState);
	assert.ok([...parent.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every(header => header.getAttribute('aria-expanded') === 'true'));
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Open File"]').click();
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Stage Changes"]').click();
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Discard Changes"]').click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(opened, ['file:///workspace/src/first.ts']);
	assert.deepEqual(gitActions, ['stage:src/first.ts', 'discard:src/first.ts']);
	assert.deepEqual(committedChangeSets, ['change-1']);
	const focusedViewsBeforeSnapshot = [...focusedViews];
	await pane.setInput(
		createMultiDiffEditorInput(
			URI.parse('ash-multi-diff:/history'),
			[
				{
					label: 'src/committed.ts',
					original: {
						resource: URI.parse('git-commit:/parent/committed.ts'),
						initialText: 'before',
						readOnly: true,
					},
					modified: {
						resource: URI.parse('git-commit:/commit/committed.ts'),
						initialText: 'after',
						readOnly: true,
					},
				},
			],
			'Committed changes',
			{ kind: 'snapshot', repositoryId: 'repo', label: 'Committed changes' },
		),
		new AbortController().signal,
	);
	assert.deepEqual(focusedViews, focusedViewsBeforeSnapshot, 'A historical snapshot must not redirect focus to the working tree view');
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-toolbar'), null);
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-source-toolbar'), null);
	assert.deepEqual(opened, ['file:///workspace/src/first.ts']);
	assert.equal(parent.querySelector('button[aria-label="Commit"]'), null);
	assert.equal(parent.querySelector('button[aria-label="Stage Changes"]'), null);
	assert.equal(parent.querySelector('button[aria-label="Discard Changes"]'), null);
	assert.deepEqual(gitActions, ['stage:src/first.ts', 'discard:src/first.ts']);
	pane.setVisible(false);
	assert.equal((parent.firstElementChild as HTMLElement).hidden, true);
	pane.clearInput();
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor').length, 0);
	assert.equal(services.get(ICodeEditorService).listDiffEditors().length, 0);
	assert.equal(services.get(ICodeEditorService).listCodeEditors().length, 0);
	await pane.setInput(
		createMultiDiffEditorInput(URI.parse('ash-multi-diff:/empty'), [], 'No changes', {
			kind: 'snapshot',
			repositoryId: 'repo',
			label: 'Changes',
		}),
		new AbortController().signal,
	);
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-empty')?.textContent, 'No changes in this selection.');
	pane.clearInput();
	pane.dispose();
	assert.equal(parent.children.length, 0);
	dom.window.close();
});

test('Multi-diff pane acquires text models as files enter the viewport and releases them on clear', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services, resources);
	const acquired: string[] = [];
	const released: string[] = [];
	const trackedModels: ITextModelResourceService = {
		async acquire(input: TextModelInput, signal: AbortSignal): Promise<TextModelReference> {
			const reference = await models.acquire(input, signal);
			acquired.push(input.resource.toString());
			let disposed = false;
			const dispose = (): void => {
				if (disposed) return;
				disposed = true;
				released.push(input.resource.toString());
				reference.dispose();
			};
			return {
				resource: reference.resource,
				model: reference.model,
				get isDirty() {
					return reference.isDirty;
				},
				onDidChangeDirty: reference.onDidChangeDirty,
				get hasExternalChange() {
					return reference.hasExternalChange;
				},
				onDidChangeExternalChange: reference.onDidChangeExternalChange,
				save: (signal, options) => reference.save(signal, options),
				saveAs: (resource, signal) => reference.saveAs(resource, signal),
				revert: signal => reference.revert(signal),
				dispose,
				[Symbol.dispose]: dispose,
			};
		},
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: trackedModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 600, height: 240 });
	const items = Array.from({ length: 100 }, (_, index) => ({
		label: `file-${index}.ts`,
		original: { resource: URI.parse(`git-change:/lazy/${index}/original`), initialText: `old ${index}` },
		modified: { resource: URI.parse(`git-change:/lazy/${index}/modified`), initialText: `new ${index}` },
	}));
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/lazy'), items, 'Lazy files'), new AbortController().signal);
	assert.ok(acquired.length > 0 && acquired.length < 20);
	assert.ok(acquired.every(resource => /\/lazy\/[0-9]\//.test(resource) && Number(resource.match(/\/lazy\/(\d+)\//)?.[1]) < 10));
	const editable = pane.getControl()!.modifiedEditor.getModel()!;
	editable.pushStackElement();
	editable.pushEditOperations(null, [{ range: editable.getFullModelRange(), text: 'unsaved edit' }], () => null);
	editable.pushStackElement();
	const editor = requiredElement<HTMLElement>(parent, '.stanza-multi-diff-editor');
	const content = requiredElement<HTMLElement>(editor, '.stanza-multi-diff-editor-content');
	// jsdom has no layout; the scrollbar needs the viewport's real measured bounds.
	Object.defineProperties(editor, {
		clientHeight: { get: () => 240 },
		scrollHeight: { get: () => parseFloat(content.style.height) },
	});
	editor.scrollTop = parseFloat(content.style.height) - 200;
	editor.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
	await new Promise<void>(resolve => {
		const ready = (): boolean =>
			[...editor.querySelectorAll('.stanza-multi-diff-editor-section')].some(
				section => section.querySelector('.stanza-multi-diff-editor-title')?.textContent === 'file-99.ts' && section.querySelector('.stanza-diff-editor') !== null,
			);
		if (ready()) return resolve();
		const observer = new dom.window.MutationObserver(() => {
			if (!ready()) return;
			observer.disconnect();
			resolve();
		});
		observer.observe(editor, { childList: true, subtree: true });
	});
	assert.ok(acquired.length < 30);
	assert.equal(editable.getValue(), 'unsaved edit');
	await editable.undo();
	assert.equal(editable.getValue(), 'new 0', 'Virtualization must preserve undo in writable files');
	await editable.redo();
	assert.equal(editable.getValue(), 'unsaved edit');
	pane.clearInput();
	assert.deepEqual(released.slice().sort(), acquired.slice().sort());
	dom.window.close();
});

test('Multi-diff evicts unused snapshots, reloads them for navigation and bounds retained references', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services, resources);
	const acquired: string[] = [];
	const released: string[] = [];
	const trackedModels: ITextModelResourceService = {
		async acquire(input: TextModelInput, signal: AbortSignal): Promise<TextModelReference> {
			const reference = await models.acquire(input, signal);
			acquired.push(input.resource.toString());
			let disposed = false;
			const dispose = (): void => {
				if (disposed) return;
				disposed = true;
				released.push(input.resource.toString());
				reference.dispose();
			};
			return {
				resource: reference.resource,
				model: reference.model,
				get isDirty() {
					return reference.isDirty;
				},
				onDidChangeDirty: reference.onDidChangeDirty,
				get hasExternalChange() {
					return reference.hasExternalChange;
				},
				onDidChangeExternalChange: reference.onDidChangeExternalChange,
				save: (signal, options) => reference.save(signal, options),
				saveAs: (resource, signal) => reference.saveAs(resource, signal),
				revert: signal => reference.revert(signal),
				dispose,
				[Symbol.dispose]: dispose,
			};
		},
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: trackedModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 600, height: 240 });
	const items = Array.from({ length: 12 }, (_, index) => ({
		label: `file-${index}.ts`,
		original: { resource: URI.parse(`git-change:/lazy/${index}/original`), initialText: `old ${index}` },
		modified: {
			resource: URI.parse(`git-change:/lazy/${index}/modified`),
			initialText: `new ${index}`,
			readOnly: true,
		},
	}));
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/lazy'), items, 'Lazy files'), new AbortController().signal);
	assert.ok(acquired.length > 0 && acquired.length < 20);
	assert.ok(acquired.every(resource => /\/lazy\/[0-9]\//.test(resource) && Number(resource.match(/\/lazy\/(\d+)\//)?.[1]) < 10));
	const initial = pane.getControl()!.modifiedEditor.getModel()!;
	pane.collapseAll();
	for (let index = 1; index < items.length; index++) {
		const location = await pane.nextChange();
		assert.ok(location);
		assert.equal(pane.getControl()!.modifiedEditor.getModel()!.getValue(), `new ${index}`);
		pane.collapseAll();
		assert.ok(acquired.length - released.length <= 10, 'At most five unused pairs may stay cached');
	}
	assert.ok(initial.isDisposed(), 'The first historical text model should be evicted');
	await pane.nextChange();
	const reloaded = pane.getControl()!.modifiedEditor.getModel()!;
	assert.notEqual(reloaded, initial);
	assert.equal(reloaded.getValue(), 'new 0');
	pane.clearInput();
	assert.deepEqual(released.slice().sort(), acquired.slice().sort());
	dom.window.close();
});

test('Multi-diff pane keeps available files open when one comparison fails to load', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services, resources);
	const partialModels: ITextModelResourceService = {
		acquire: (input, signal) => (input.resource.path.includes('/broken/') ? Promise.reject(new Error('Unavailable')) : models.acquire(input, signal)),
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: partialModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 600, height: 300 });
	await pane.setInput(
		createMultiDiffEditorInput(
			URI.parse('ash-multi-diff:/partial'),
			[
				{
					label: 'available.ts',
					original: { resource: URI.parse('git-change:/available/original'), initialText: 'old' },
					modified: { resource: URI.parse('git-change:/available/modified'), initialText: 'new' },
				},
				{
					label: 'broken.ts',
					original: { resource: URI.parse('git-change:/broken/original'), initialText: 'old' },
					modified: { resource: URI.parse('git-change:/broken/modified'), initialText: 'new' },
				},
			],
			'Partial',
		),
		new AbortController().signal,
	);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session.pending').length, 0);
	assert.equal(parent.querySelectorAll('.stanza-diff-editor').length, 1);
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-incomplete-status:not(:empty)')?.textContent, 'Could not load broken.ts');
	pane.clearInput();
	assert.equal(parent.querySelector('.stanza-multi-diff-editor'), null);
	dom.window.close();
});

for (const cancellation of ['signal', 'clear'] as const) {
	test(`Multi-diff pane releases a model delivered after ${cancellation === 'signal' ? 'input cancellation' : 'clearing pending input'}`, async () => {
		const dom = createTestDom();
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
		using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		registerDialogs(services, resources);
		const originalInput = { resource: URI.parse('git-change:/cancel/original'), initialText: 'old' };
		const reference = await models.acquire(originalInput, new AbortController().signal);
		let modelDisposed = false;
		using listener = reference.model.onWillDispose(() => {
			modelDisposed = true;
		});
		let signalAcquisitionStarted: (() => void) | undefined;
		const acquisitionStarted = new Promise<void>(resolve => {
			signalAcquisitionStarted = resolve;
		});
		let deliver: ((reference: TextModelReference) => void) | undefined;
		const delayedModels: ITextModelResourceService = {
			acquire: async () => {
				signalAcquisitionStarted?.();
				return new Promise<TextModelReference>(resolve => {
					deliver = resolve;
				});
			},
			dispose: () => models.dispose(),
			[Symbol.dispose]: () => models.dispose(),
		};
		using pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
			modelService: delayedModels,
			createComputationService: () => new PaneTestDiffComputationService(),
		} satisfies MultiDiffEditorOptions);
		pane.create(parent);
		pane.layout({ width: 400, height: 240 });
		const controller = new AbortController();
		const pending = pane.setInput(
			createMultiDiffEditorInput(
				URI.parse('ash-multi-diff:/cancel'),
				[
					{
						label: 'cancel.ts',
						original: originalInput,
						modified: { resource: URI.parse('git-change:/cancel/modified'), initialText: 'new' },
					},
				],
				'Cancel',
			),
			controller.signal,
		);
		await acquisitionStarted;
		assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session.pending').length, 1);
		if (cancellation === 'signal') controller.abort();
		else pane.clearInput();
		deliver!(reference);
		await assert.rejects(pending, /cancelled/);
		assert.equal(modelDisposed, true);
		assert.equal(parent.querySelector('.stanza-multi-diff-editor'), null);
		dom.window.close();
	});
}

test('Multi-diff collapse command updates mounted and remounted comparisons and preserves the active file', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services, resources);
	const configuration = services.get(IConfigurationService);
	const updateValue = configuration.updateValue.bind(configuration);
	configuration.updateValue = async (key, value) => {
		// Workbench removes writes equal to the user default without publishing a value change.
		if (key === CodeEditorConfiguration.diffHideUnchangedRegionsEnabled && value === false && configuration.getValue(key) === false) return;
		await updateValue(key, value);
	};
	using pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	});
	pane.create(parent);
	pane.layout({ width: 1000, height: 900 });
	const lines = Array.from({ length: 36 }, (_, index) => `shared ${index + 1}`);
	await pane.setInput(
		createMultiDiffEditorInput(
			URI.parse('ash-multi-diff:/hidden'),
			['first', 'second'].map(name => ({
				label: `${name}.ts`,
				original: { resource: URI.parse(`git-change:/${name}/original`), initialText: lines.join('\n') },
				modified: {
					resource: URI.parse(`git-change:/${name}/modified`),
					initialText: [...lines.slice(0, -1), 'changed'].join('\n'),
				},
			})),
			'Hidden regions',
		),
		new AbortController().signal,
	);
	await pane.nextChange();
	const regions = () => parent.querySelectorAll('.ash-diff-hidden-region');
	assert.equal(regions().length, 4, 'Multi-diff folds unchanged regions without changing the ordinary diff default');
	assert.equal(configuration.getValue(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled), false);
	await pane.toggleCollapseUnchangedRegions();
	assert.equal(regions().length, 0);
	assert.equal(configuration.inspect(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled).memoryValue, undefined);
	await pane.toggleCollapseUnchangedRegions();
	assert.equal(regions().length, 4);
	assert.ok([...parent.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every(header => header.getAttribute('aria-expanded') === 'true'));
	assert.equal(configuration.getValue(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled), true);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 100);
	assert.equal(regions().length, 0);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 3);
	assert.equal(regions().length, 4);
	pane.collapseAll();
	assert.equal(regions().length, 0);
	pane.expandAll();
	assert.equal(regions().length, 4);
	assert.equal(pane.getActiveDiffItem()?.label, 'second.ts');
	pane.collapseAll();
	assert.equal(pane.getActiveDiffItem()?.label, 'second.ts');
	await pane.toggleCollapseUnchangedRegions();
	pane.expandAll();
	assert.equal(regions().length, 0);
	await pane.toggleCollapseUnchangedRegions();
	assert.equal(regions().length, 4);
	assert.equal(configuration.getValue(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled), true);
	pane.dispose();
	dom.window.close();
});

test('Multi-diff pane inherits word wrap and routes the toggle command to its view', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services, resources);

	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.wordWrap, EditorLineWrapping.On);
	const pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 400, height: 200 });
	await pane.setInput(
		createMultiDiffEditorInput(
			URI.parse('ash-multi-diff:/wrap'),
			[
				{
					label: 'wrap.ts',
					original: {
						resource: URI.parse('git-change:/wrap/original'),
						initialText: 'old ' + 'value '.repeat(40),
					},
					modified: {
						resource: URI.parse('git-change:/wrap/modified'),
						initialText: 'new ' + 'value '.repeat(40),
					},
				},
			],
			'Wrap',
		),
		new AbortController().signal,
	);
	await Promise.resolve();
	const editor = requiredElement<HTMLElement>(dom.window.document, '.stanza-multi-diff-editor');
	assert.equal(editor.classList.contains('word-wrapped'), true);
	services.registerInstance(IEditorPartsService, { activePane: pane } as unknown as IEditorPartsService);
	await services.get(ICommandService).executeCommand('editor.action.toggleWordWrap');
	assert.equal(editor.classList.contains('word-wrapped'), false);
	await configuration.updateValue(CodeEditorConfiguration.diffWordWrap, 'off');
	assert.equal(editor.classList.contains('word-wrapped'), false);
	pane.toggleWordWrap();
	assert.equal(editor.classList.contains('word-wrapped'), false);
	await configuration.updateValue(CodeEditorConfiguration.diffWordWrap, 'on');
	assert.equal(editor.classList.contains('word-wrapped'), true);
	pane.dispose();
	dom.window.close();
});

test('Multi-diff configuration and registered file menus work in Chinese', async () => {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	const dom = createTestDom();
	try {
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		registerDialogs(services, resources);
		using contexts = new ContextKeyService();
		using commands = new CommandService(services);
		using action = registerAction2(MultiDiffGoToFileAction);
		const menus = new MenuService(commands, contexts);
		const opened: string[] = [];
		const editors = {
			openEditor: async (input: IResourceEditorInput) => {
				opened.push(input.resource.toString());
			},
		} as IEditorService;
		services.registerInstance(IEditorService, editors);
		using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
		using pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
			modelService: models,
			createComputationService: () => new PaneTestDiffComputationService(),
			editorService: editors,
			fileActions: {
				menuService: menus,
				contextKeyService: contexts,
				contextMenuProvider: { showContextMenu() {} },
			},
		});
		const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
		pane.create(parent);
		pane.layout({ width: 600, height: 400 });
		const input = createMultiDiffEditorInput(
			URI.parse('ash-multi-diff:/localized'),
			['first.ts', 'second.ts'].map(label => ({
				label,
				original: { resource: URI.parse(`git-change:/original/${label}`), initialText: 'before' },
				modified: { resource: URI.parse(`git-change:/modified/${label}`), initialText: 'after' },
				goToFile: { resource: URI.file(`/workspace/${label}`) },
				actions: [
					{ id: 'test.stage', label: '暂存更改', tooltip: '暂存更改', command: 'test.stage', arguments: [] },
					{
						id: 'test.discard',
						label: '放弃更改',
						tooltip: '放弃更改',
						command: 'test.discard',
						arguments: [],
					},
				],
			})),
			'比较',
		);
		await pane.setInput(input, new AbortController().signal);
		await waitForPane(() =>
			services
				.get(ICodeEditorService)
				.listDiffEditors()
				.every(editor => editor.getModifiedEditor().getModel() !== null),
		);
		assert.equal(parent.querySelector('.stanza-multi-diff-editor')?.getAttribute('aria-label'), '比较，2 个文件');
		assert.equal(parent.querySelector('.stanza-multi-diff-editor-file-actions .ash-toolbar')?.getAttribute('aria-label'), 'first.ts 操作');
		requiredElement<HTMLButtonElement>(parent, 'button[aria-label="暂存更改"]');
		requiredElement<HTMLButtonElement>(parent, 'button[aria-label="放弃更改"]');
		const headers = parent.querySelectorAll<HTMLButtonElement>('.stanza-multi-diff-editor-header-toggle');
		headers[1]!.focus();
		requiredElement<HTMLButtonElement>(parent, 'button[aria-label="打开文件"]').click();
		await Promise.resolve();
		assert.deepEqual(opened, ['file:///workspace/first.ts']);
		const configuration = services.get(IConfigurationService);
		await configuration.updateValue(CodeEditorConfiguration.lineHeight, 30);
		await configuration.updateValue(CodeEditorConfiguration.diffShowLineNumbers, false);
		await configuration.updateValue(CodeEditorConfiguration.diffShowInlineChanges, false);
		await configuration.updateValue(CodeEditorConfiguration.diffLoopChanges, false);
		for (const editor of services.get(ICodeEditorService).listCodeEditors()) assert.equal(editor.getOption(EditorOption.lineHeight), 30);
		assert.ok(parent.querySelector('.stanza-multi-diff-editor.hide-line-numbers'));
		await pane.nextChange();
		const last = await pane.nextChange();
		assert.equal(pane.getActiveDiffItem()?.label, 'second.ts');
		assert.deepEqual(await pane.nextChange(), last);
		await configuration.updateValue(CodeEditorConfiguration.diffLoopChanges, true);
		await pane.nextChange();
		assert.equal(pane.getActiveDiffItem()?.label, 'first.ts');
		await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/localized-empty'), [], '比较'), new AbortController().signal);
		assert.equal(parent.querySelector('.stanza-multi-diff-editor-empty')?.textContent, '此选择中没有更改。');
	} finally {
		dom.window.close();
		resetNlsResolver();
	}
});

async function waitForPane(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Multi-diff pane did not reach the expected state');
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

class BootstrapTextFiles implements ITextFileService {
	readonly onDidSave = Event.None;
	readonly onDidChangeFiles = () => ({ dispose() {}, [Symbol.dispose]() {} });

	async resolve(request: TextFileResolveRequest): Promise<ResolvedTextFileContent> {
		return {
			resource: request.resource,
			text: request.bootstrapText ?? '',
			source: request.bootstrapText === undefined ? TextFileContentSource.FileSystem : TextFileContentSource.Bootstrap,
			revision: undefined,
			encoding: 'utf8',
		};
	}

	async save(): Promise<{ readonly revision: string | undefined }> {
		return { revision: undefined };
	}
}

class PaneTestDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;
	constructor(private readonly observe?: (options: IDocumentDiffProviderOptions) => void) {}

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		this.observe?.(options);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return {
			identical: original.getValue() === modified.getValue(),
			quitEarly: result.hitTimeout,
			changes: result.changes,
			moves: result.moves,
		};
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function createTestDom(): JSDOM {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	// Workbench themes supply semantic diff icons; a pane-only fixture must bind the same registry.
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	return dom;
}

function requiredElement<T extends Element>(ownerDocument: ParentNode, selector: string): T {
	const element = ownerDocument.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}

suite('Multi-diff extension source lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services, resources);
	const models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
	const updates = new Emitter<{ repositoryId: string; revision: number; changes?: { path: string }[] }>();
	let liveStatus = {
		repositoryId: 'repo',
		streamInstanceId: 'stream',
		revision: 1,
		historyRevision: 1,
		workspacePath: '/workspace',
		head: { type: 'unborn', name: 'main' },
		changes: ['first.ts', 'second.ts'].map(path => ({
			path,
			originalPath: undefined,
			indexStatus: 'unmodified',
			worktreeStatus: 'modified',
			conflicted: false,
			submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false },
		})),
	};
	let releaseSlow: (() => void) | undefined;
	const slow = new Promise<void>(resolve => {
		releaseSlow = resolve;
	});
	const git = {
		onDidChangeRepositoryStatus: updates.event,
		status: async (repositoryId: string) => {
			assert.equal(repositoryId, 'repo');
			return liveStatus;
		},
		changeFile: async (path: string) => {
			const revision = liveStatus.revision;
			if (revision === 2) await slow;
			return {
				original: { kind: 'text', text: 'before' },
				modified: { kind: 'text', text: `${path} revision ${revision}` },
			};
		},
	};
	let acquired = 0;
	let released = 0;
	const tracked: ITextModelResourceService = {
		async acquire(input, signal) {
			const reference = await models.acquire(input, signal);
			acquired++;
			let disposed = false;
			const dispose = (): void => {
				if (disposed) return;
				disposed = true;
				released++;
				reference.dispose();
			};
			return {
				resource: reference.resource,
				model: reference.model,
				get isDirty() {
					return reference.isDirty;
				},
				onDidChangeDirty: reference.onDidChangeDirty,
				get hasExternalChange() {
					return reference.hasExternalChange;
				},
				onDidChangeExternalChange: reference.onDidChangeExternalChange,
				save: (signal, options) => reference.save(signal, options),
				saveAs: (resource, signal) => reference.saveAs(resource, signal),
				revert: signal => reference.revert(signal),
				dispose,
				[Symbol.dispose]: dispose,
			};
		},
		dispose() {},
		[Symbol.dispose]() {},
	};
	// Generic source lifecycle uses immutable fixture contents, without a Git implementation in the UI process.
	let resolutions = 0;
	async function resolveFixtureInput() {
		const snapshot = liveStatus;
		const items = await Promise.all(
			snapshot.changes.map(async change => {
				const contents = await git.changeFile(change.path);
				return {
					id: change.path,
					label: change.path,
					original: {
						resource: URI.parse(`test-before:/${snapshot.revision}/${change.path}`),
						initialText: contents.original.text,
						readOnly: true,
					},
					modified: {
						resource: URI.parse(`test-after:/${snapshot.revision}/${change.path}`),
						initialText: contents.modified.text,
						readOnly: true,
					},
				};
			}),
		);
		resolutions++;
		return createMultiDiffEditorInput(URI.parse('ash-scm:/fixture'), items, 'Changes', {
			kind: 'external',
			providerId: 'test',
			repositoryId: 'repo',
			label: 'Changes',
		});
	}
	const resolvers = services.get(IMultiDiffSourceResolverService);
	resources.add(
		resolvers.registerResolver({
			canHandleUri: uri => uri.scheme === 'ash-scm',
			resolveDiffSource: async () => {
				const input = await resolveFixtureInput();
				return { resource: input.resource, resources: input.items, label: input.label, source: input.source };
			},
			sourceActions: () => [],
			primaryRepositoryAction: () => undefined,
		}),
	);
	resources.add(
		updates.event(status => {
			if (status.repositoryId === 'repo') resolvers.notifyChanged();
		}),
	);
	const pane = registerMultiDiffTestServices(services).createInstance(MultiDiffEditor, {
		modelService: tracked,
		createComputationService: () => new PaneTestDiffComputationService(),
	});
	pane.create(parent);
	pane.layout({ width: 600, height: 400 });
	suiteSetup(async () => {
		await pane.setInput(await resolveFixtureInput(), new AbortController().signal);
	});
	suiteTeardown(() => {
		pane.dispose();
		models.dispose();
		updates.dispose();
		resources.dispose();
		dom.window.close();
	});

	test('retains reviewed models when a source returns the same snapshot', async () => {
		await waitForPane(() => !!pane.getControl()?.modifiedEditor.getModel());
		const model = pane.getControl()!.modifiedEditor.getModel();
		const initialReleased = released;
		const initialResolutions = resolutions;
		updates.fire(liveStatus);
		await waitForPane(() => resolutions > initialResolutions);
		assert.equal(pane.getControl()!.modifiedEditor.getModel(), model);
		assert.equal(released, initialReleased);
	});

	test('replaces revisions in place and releases retired text models', async () => {
		const widget = requiredElement<HTMLElement>(parent, '.stanza-multi-diff-editor');
		const firstHeader = requiredElement<HTMLButtonElement>(parent, '.stanza-multi-diff-editor-header-toggle');
		firstHeader.click();
		const secondHeader = parent.querySelectorAll<HTMLButtonElement>('.stanza-multi-diff-editor-header-toggle')[1]!;
		secondHeader.focus();
		const initialReleased = released;
		liveStatus = { ...liveStatus, revision: 2 };
		updates.fire(liveStatus);
		await Promise.resolve();
		liveStatus = { ...liveStatus, revision: 3 };
		updates.fire(liveStatus);
		await waitForPane(() => pane.getControl()?.modifiedEditor.getModel()?.getValue() === 'second.ts revision 3');
		assert.equal(parent.querySelector('.stanza-multi-diff-editor'), widget);
		assert.equal(pane.getActiveDiffItem()?.label, 'second.ts');
		assert.equal(parent.querySelector('.stanza-multi-diff-editor-header-toggle')?.getAttribute('aria-expanded'), 'false');
		assert.ok(released > initialReleased);
		releaseSlow!();
		await slow;
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(pane.getControl()?.modifiedEditor.getModel()?.getValue(), 'second.ts revision 3');
		updates.fire({ ...liveStatus, repositoryId: 'other', revision: 4, changes: [] });
		assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-title').length, 2);
		liveStatus = { ...liveStatus, revision: 4, changes: [] };
		updates.fire(liveStatus);
		await waitForPane(() => parent.querySelector('.stanza-multi-diff-editor-empty') !== null);
		assert.equal(parent.querySelectorAll('.stanza-diff-editor').length, 0);
		assert.equal(acquired, released);
		pane.clearInput();
		updates.fire({ ...liveStatus, revision: 5 });
		assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session').length, 0);
		pane.dispose();
		models.dispose();
		updates.dispose();
		resources.dispose();
	});
});

suite('MultiDiff binary and persistence', () => {
	const sharedResources = new DisposableStore();
	let sharedServices: InstantiationService;
	suiteSetup(async () => {
		// Window services and font caches outlive individual panes in this shared document.
		sharedServices = registerMultiDiffTestServices(createCodeEditorServices(sharedResources));
		registerDialogs(sharedServices, sharedResources);
		using resources = new DisposableStore();
		const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {}));
		const host = browserEnvironment.window.document.createElement('div');
		browserEnvironment.window.document.body.append(host);
		resources.add({ dispose: () => host.remove(), [Symbol.dispose]: () => host.remove() });
		const pane = resources.add(
			sharedServices.createInstance(MultiDiffEditor, {
				modelService: models,
				createComputationService: () => new PaneTestDiffComputationService(),
			}),
		);
		pane.create(host);
		pane.layout({ width: 600, height: 300 });
		await pane.setInput(
			createMultiDiffEditorInput(
				URI.parse('ash-multi-diff:/warmup'),
				[
					{
						label: 'warmup.ts',
						original: { resource: URI.parse('snapshot:/warmup-before'), initialText: 'before' },
						modified: {
							resource: URI.parse('snapshot:/warmup-after'),
							initialText: 'after',
							readOnly: true,
						},
					},
				],
				'Warmup',
			),
			new AbortController().signal,
		);
	});
	suiteTeardown(() => sharedResources.dispose());
	ensureNoDisposablesAreLeakedInTestSuite();
	function createPaneServices(resources: DisposableStore): InstantiationService {
		const overrides = resources.add(new InstantiationService());
		overrides.registerInstance(IAccessibilityService, sharedServices.get(IAccessibilityService));
		return registerMultiDiffTestServices(createCodeEditorServices(resources, overrides));
	}

	test('a binary file discovered while loading releases text references and displays the binary section', async () => {
		using resources = new DisposableStore();
		const services = createPaneServices(resources);
		registerDialogs(services, resources);
		const models = resources.add(
			uriIdentityServices.createInstance(
				BrowserTextModelService,
				{
					onDidChange: Event.None,
					resolve: async request => {
						if (request.resource.scheme === 'file') throw new TextFileBinaryError(request.resource);
						return { resource: request.resource, text: 'before', revision: undefined };
					},
					save: async () => assert.fail('Binary files cannot be saved as text'),
				} satisfies import('../../../../services/textmodelResolver/common/textResourceStore.js').ITextResourceStore,
				{},
			),
		);
		const host = browserEnvironment.window.document.createElement('div');
		browserEnvironment.window.document.body.append(host);
		resources.add({ dispose: () => host.remove(), [Symbol.dispose]: () => host.remove() });
		const pane = resources.add(
			services.createInstance(MultiDiffEditor, {
				modelService: models,
				createComputationService: () => new PaneTestDiffComputationService(),
			}),
		);
		pane.create(host);
		pane.layout({ width: 600, height: 300 });
		await pane.setInput(
			createMultiDiffEditorInput(
				URI.parse('ash-multi-diff:/detected-binary'),
				[
					{
						label: 'detected.bin',
						original: { resource: URI.parse('snapshot:/detected.bin'), readOnly: true },
						modified: { resource: URI.file('/workspace/detected.bin') },
					},
				],
				'Binary review',
			),
			new AbortController().signal,
		);
		assert.match(host.querySelector('.stanza-multi-diff-editor-item-editor.binary')!.textContent!, /Binary file changed/);
		assert.equal(host.querySelector('.stanza-editor'), null);
		assert.deepEqual(models.getModels(), []);
		assert.deepEqual(pane.getWorkingCopies(), []);
		await pane.save();
	});

	test('binary entries retain actions without acquiring models and Save persists collapsed writable files', async () => {
		using resources = new DisposableStore();
		const services = createPaneServices(resources);
		registerDialogs(services, resources);
		const acquired: string[] = [];
		const saved: { resource: string; text: string }[] = [];
		let failSave = false;
		const models = resources.add(
			uriIdentityServices.createInstance(
				BrowserTextModelService,
				{
					onDidChange: Event.None,
					resolve: async request => {
						acquired.push(request.resource.path);
						return { resource: request.resource, text: request.bootstrapText ?? '', revision: undefined };
					},
					save: async request => {
						if (failSave) throw new Error('Conflict while saving');
						saved.push({ resource: request.resource.path, text: request.text });
						return { revision: undefined };
					},
				} satisfies import('../../../../services/textmodelResolver/common/textResourceStore.js').ITextResourceStore,
				{},
			),
		);
		const host = browserEnvironment.window.document.createElement('div');
		browserEnvironment.window.document.body.append(host);
		resources.add({ dispose: () => host.remove(), [Symbol.dispose]: () => host.remove() });
		const pane = resources.add(
			services.createInstance(MultiDiffEditor, {
				modelService: models,
				createComputationService: () => new PaneTestDiffComputationService(),
			}),
		);
		pane.create(host);
		pane.layout({ width: 600, height: 300 });
		const items = [
			{
				label: 'image.bin',
				binary: true,
				original: { resource: URI.parse('snapshot:/image.bin'), readOnly: true },
				modified: { resource: URI.file('/workspace/image.bin') },
			},
			...['first', 'second'].map(name => ({
				label: `${name}.ts`,
				original: { resource: URI.parse(`snapshot:/${name}.ts`), initialText: 'before', readOnly: true },
				modified: { resource: URI.file(`/workspace/${name}.ts`), initialText: 'after' },
			})),
			{
				label: 'readonly.ts',
				original: { resource: URI.parse('snapshot:/readonly.ts'), initialText: 'before', readOnly: true },
				modified: { resource: URI.parse('snapshot:/after/readonly.ts'), initialText: 'after', readOnly: true },
			},
		];
		const input = createMultiDiffEditorInput(URI.parse('ash-multi-diff:/writable'), items, 'Writable review');
		await pane.setInput(input, new AbortController().signal);
		assert.equal(input.readOnly, false);
		assert.match(host.querySelector('.stanza-multi-diff-editor-item-editor.binary')!.textContent!, /Binary file changed/);
		assert.equal(
			acquired.some(path => path.endsWith('image.bin')),
			false,
		);
		pane.collapseAll();
		const first = resources.add(await models.acquire(items[1].modified, new AbortController().signal));
		const second = resources.add(await models.acquire(items[2].modified, new AbortController().signal));
		first.model.reset('first edit');
		second.model.reset('second edit');
		await pane.save();
		assert.deepEqual(saved, [
			{ resource: '/workspace/first.ts', text: 'first edit' },
			{ resource: '/workspace/second.ts', text: 'second edit' },
		]);
		assert.deepEqual(
			pane.getWorkingCopies().map(copy => copy.isDirty),
			[false, false],
		);
		assert.equal(services.get(IWorkingCopyService).getAll().length, 2);
		first.model.reset('unsaved');
		failSave = true;
		await assert.rejects(pane.save(), /Conflict while saving/);
		assert.equal(first.isDirty, true);
		assert.equal(first.model.getText(), 'unsaved');
		pane.clearInput();
		assert.equal(services.get(IWorkingCopyService).getAll().length, 0);
	});
});
