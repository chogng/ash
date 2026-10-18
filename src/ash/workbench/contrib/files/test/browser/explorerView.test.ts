import { BrowserPathService } from '../../../../services/path/browser/pathService.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { ILabelService, LabelService } from '../../../../../platform/label/common/labelService.js';
import { IDecorationsService } from '../../../../services/decorations/common/decorations.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { noFileIconTheme } from '../../../../../platform/theme/common/themeService.js';
import { EditorOpenSource } from '../../../../../platform/editor/common/editor.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { isWindows } from '../../../../../base/common/platform.js';
import { Emitter, Event } from "../../../../../base/common/event.js";
import { DecorationsService } from '../../../../services/decorations/browser/decorationsService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { ConfigurationRegistry, Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ExplorerFileNestingSettingId } from '../../common/explorerFileNestingTrie.js';
import '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import '../../browser/files.contribution.js';
import { FileKind, FileNotFoundError, type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from "../../../../../platform/files/common/files.js";
import { TestWorkspaceService } from "../../../../services/configuration/test/common/testServices.js";
import { IResourceIconRenderer } from "../../../../browser/labels.js";
import { IHoverService, type IManagedHover } from "../../../../../platform/hover/browser/hoverService.js";
import { ListConfiguration } from "../../../../../platform/list/browser/listService.js";
import type { EditorOpenOptions, EditorOpenTarget, IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { IContextMenuMenuDelegate, IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IExplorerService } from '../../browser/files.js';

test("ExplorerView opens workspace files on single click", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	// jsdom has no layout; managed virtualization needs a visible viewport to create rows.
	Object.defineProperty(browser.window.HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() { return this.isConnected && this.classList.contains('ash-scrollbar-viewport') ? 500 : 0; },
	});
	const installedGlobals = installDomGlobals(browser);
	const root = URI.file("/project");
	const nextRoot = URI.file("/next-project");
	const directoryReads: string[] = [];
	const metadataChecks: string[] = [];
	let mainExists = true;
	let mainKind = FileKind.File;
	let sourceExists = true;
	using fileChanges = new Emitter<{ readonly resources: readonly URI[] | undefined; }>();
	let addedRootFile = false;
	let addedNestedFile = false;
	let failNextRootRead = false;
	let pauseSourceRead = false;
	let completeSourceRead: (() => void) | undefined;
	let openedInput: IResourceEditorInput | undefined;
	let openedOptions: EditorOpenOptions | undefined;
	let openedTarget: EditorOpenTarget | undefined;
	let editorFocusCount = 0;
	let hoverCreations = 0;
	let hoverDisposals = 0;
	let contextMenu: IContextMenuMenuDelegate | undefined;
	const fileProvider: IFileSystemProvider = {
		capabilities: FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy,
		onDidChangeCapabilities: Event.None,
		watch: (): IDisposable => Disposable.None,

		onDidChangeFiles: fileChanges.event,
		stat: async resource => {
			metadataChecks.push(resource.path);
			assert.equal(resource.path, '/project/src/main.ts');
			if (!mainExists) throw new FileNotFoundError(resource);
			return { resource, kind: mainKind, sizeBytes: 1, readonly: false, modifiedAtMillis: undefined };
		},
		readDirectory: async (resource) => {
			directoryReads.push(resource.toString());
			if (resource.path === '/project/src' && pauseSourceRead) {
				pauseSourceRead = false;
				await new Promise<void>(resolve => { completeSourceRead = resolve; });
			}
			if (resource.toString() === root.toString()) {
				if (failNextRootRead) {
					failNextRootRead = false;
					throw new Error("Workspace files are temporarily unavailable");
				}
				return [
					{
						resource: URI.file("/project/README.md"),
						name: "README.md",
						kind: FileKind.File,
					},
					...(sourceExists ? [{
						resource: URI.file("/project/src"),
						name: "src",
						kind: FileKind.Directory,
					}] : []),
					...(addedRootFile ? [{
						resource: URI.file("/project/new.txt"),
						name: "new.txt",
						kind: FileKind.File,
					}] : []),
				];
			}
			if (resource.toString() === nextRoot.toString()) {
				return [
					{
						resource: URI.file("/next-project/next.txt"),
						name: "next.txt",
						kind: FileKind.File,
					},
					{
						resource: URI.file("/next-project/link"),
						name: "link",
						kind: FileKind.SymbolicLink,
					},
					{
						resource: URI.file("/next-project/unknown"),
						name: "unknown",
						kind: FileKind.Other,
					},
				];
			}
			return [...(mainExists ? [{
				resource: URI.file("/project/src/main.ts"),
				name: "main.ts",
				kind: mainKind,
			}] : []), ...(addedNestedFile ? [{
				resource: URI.file('/project/src/nested.ts'),
				name: 'nested.ts',
				kind: FileKind.File,
			}] : [])];
		},
		readFile: async (_resource) => {
			throw new Error("Explorer must delegate file content resolution to the selected editor");
		},
		writeFile: async (resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> => {
			if (!options.overwrite) { throw new Error('File paste is not used in this test'); }
			const _request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
			throw new Error("Explorer must delegate file writes to the selected editor");
		},
		createFile: async () => { throw new Error("Explorer must not create files in this test"); },
		createDirectory: async () => { throw new Error("Explorer must not create directories in this test"); },
		copy: async () => { throw new Error("Copy is not used in this test"); },
		rename: async () => { throw new Error("Explorer must not rename files in this test"); },
		delete: async () => { throw new Error("Explorer must not delete files in this test"); },
	};
	using fileService = createTestFileService(fileProvider);
	using workspaceContextService = new TestWorkspaceService({
		id: "workspace",
		uri: root,
	});
	using activeEditorChanges = new Emitter<void>();
	let activeEditor: IResourceEditorInput | undefined;
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		onDidActiveEditorChange: activeEditorChanges.event,
		get activeEditor() { return activeEditor; },
		openEditor: async (input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget) => {
			openedInput = input;
			openedOptions = options;
			openedTarget = target;
			if (options?.preserveFocus !== true) editorFocusCount += 1;
		},
		focusActiveEditor() { editorFocusCount += 1; },
	};
	const configurationRegistry = new ConfigurationRegistry();
	for (const registered of Registry.as<IConfigurationRegistry>(Extensions.Configuration).getRegisteredConfigurations()) {
		configurationRegistry.registerConfiguration({ key: registered.key, defaultValue: registered.defaultValue, parse: registered.parse });
	}
	using configurationService = new InMemoryConfigurationService(configurationRegistry);
	await configurationService.updateValue(ListConfiguration.openMode, "doubleClick");
	await configurationService.updateValue('explorer.compactFolders', false);
	using iconChanges = new Emitter<void>();
	let fileIconTheme = { ...noFileIconTheme, hasFileIcons: true };
	const resourceIconRenderer: IResourceIconRenderer = {
		onDidChangeResourceIcons: iconChanges.event,
		getFileIconTheme: () => fileIconTheme,
		renderFileIcon: (resource, container) => {
			container.classList.add("ash-seti-file-icon");
			container.textContent = resource.path.endsWith(".ts") ? "T" : "F";
		},
	};
	const hoverService: IHoverService = {
		setupDelayedHover() { throw new Error("Unexpected delayed hover registration"); },
		setupHover: () => {
			hoverCreations += 1;
			return testManagedHover(() => { hoverDisposals += 1; });
		},
		showHover: () => testManagedHover(),
		hideHover() { },
	};

	try {
		const { ExplorerView } = await import(
			"../../../../../workbench/contrib/files/browser/views/explorerView.js"
		);
		const { ExplorerService } = await import('../../browser/explorerService.js');
		using fileService = createTestFileService(fileProvider);
		using explorerService = new ExplorerService(workspaceContextService, fileService, configurationService);
		using contextKeyService = new ContextKeyService();
		const accessibleViewService: IAccessibleViewService = {
			show: () => false,
			getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.', disableHint: async () => { }, showAccessibleViewHelp: () => { },
			dispose() { },
			[Symbol.dispose]() { },
		};
		const { EmptyView } = await import(
			"../../../../../workbench/contrib/files/browser/views/emptyView.js"
		);
		let folderOpens = 0;
		using contexts = new ContextKeyService();
		contexts.setContext('openFolderWorkspaceSupport', true);
		using emptyView = new EmptyView(
			browser.window.document.body,
			{
				id: EmptyView.ID,
				title: EmptyView.TITLE,
			},
			{ pickFolderAndOpen: async () => { folderOpens++; } } as unknown as import('../../../../../platform/dialogs/common/dialogs.js').IFileDialogService,
			contexts,
		);
		assert.equal(emptyView.element.dataset.viewId, EmptyView.ID);
		assert.equal(
			emptyView.element.querySelector(
				".ash-empty-explorer-message",
			)?.textContent,
			"Open a folder to explore its files.",
		);
		const openFolderButton =
			emptyView.element.querySelector<HTMLButtonElement>(
				".ash-empty-explorer-open-folder",
			);
		assert.equal(openFolderButton?.textContent, "Open Folder");
		openFolderButton?.click();
		await waitFor(() => folderOpens === 1);
		assert.equal(openFolderButton?.disabled, false);

		using decorations = new DecorationsService(browser.window.document, new NullLoggerService());
		using services = new InstantiationService();
		const getValue = configurationService.getValue.bind(configurationService);
		configurationService.getValue = ((section?: string) => section ? getValue(section) : getValue()) as typeof configurationService.getValue;
		services.registerInstance(IConfigurationService, configurationService);
		services.registerInstance(IWorkspaceContextService, workspaceContextService);
		services.registerInstance(IFileService, fileService);
		services.registerInstance(IDialogService, { confirm: async () => { throw new Error('Unexpected drag confirmation'); } } as unknown as IDialogService);
		services.registerInstance(IResourceIconRenderer, resourceIconRenderer);
		services.registerInstance(IHoverService, hoverService);
		services.registerInstance(IDecorationsService, decorations);
		const paths = new BrowserPathService(createDisconnectedRendererApi(), workspaceContextService);
		using labels = new LabelService(workspaceContextService, paths, createDisconnectedRendererApi());
		services.registerInstance(ILabelService, labels);
		services.registerInstance(IPathService, paths);
		using storageService = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: workspaceContextService.getWorkspace().id, flushInterval: 0, onError: () => { } });
		using commands = new CommandService(services);
		const menus = new MenuService(commands, contextKeyService);
		services.registerInstance(IExplorerService, explorerService);
		using pane = new ExplorerView(
			browser.window.document.body,
			{
				id: "ash.explorer",
				title: "Explorer",
			},
			fileService,
			workspaceContextService,
			editorService,
			resourceIconRenderer,
			configurationService,
			explorerService,
			services,
			contextKeyService,
			accessibleViewService,
			{ showContextMenu: delegate => { contextMenu = delegate as IContextMenuMenuDelegate; } } as IContextMenuService,
			commands,
			storageService,
			menus,
		);
		services.registerInstance(IViewsService, {
			openView: async () => pane,
			getViewWithId: () => pane,
		} as unknown as IViewsService);
		browser.window.document.body.append(pane.element);
		pane.setVisible(true);
		assert.equal(
			pane.element.querySelector(".ash-explorer-status")?.textContent,
			"Loading files…",
		);

		await waitFor(() => pane.element.querySelectorAll(
			".ash-tree-row",
		).length === 2);
		assert.equal(
			pane.element.querySelector(".ash-pane-view-header-title")?.textContent,
			"project",
		);
		assert.equal(
			pane.element.querySelector(".ash-pane-view-header")?.classList.contains("ash-explorer-title"),
			true,
		);
		assert.deepEqual(rowLabels(pane.element), ["src", "README.md"]);
		assert.deepEqual(pane.getActions().map(action => action.id), [
			'workbench.files.action.createFileFromExplorer',
			'workbench.files.action.createFolderFromExplorer',
			'workbench.files.action.refreshFilesExplorer',
			'workbench.files.action.collapseExplorerFolders',
		]);
		pane.setHeaderVisible(false);
		assert.equal(pane.element.querySelector('[data-action-id="workbench.files.action.createFileFromExplorer"]'), null);
		assert.equal(pane.getActions().length, 4, 'The merged title keeps the same actions');
		pane.setHeaderVisible(true);
		assert.equal(pane.element.querySelectorAll('[data-action-id="workbench.files.action.createFileFromExplorer"]').length, 1);
		assert.equal(pane.element.querySelector('.ash-icon-label-description'), null);
		assert.match(explorerService.getAccessibleContent() ?? '', /README\.md/);
		assert.match(pane.element.querySelector('.ash-tree')?.getAttribute('aria-label') ?? '', /Alt\+F1/);
		assert.equal(
			pane.element.querySelector(
				".ash-explorer .ash-scrollable-element",
			)?.getAttribute("data-scroll-direction"),
			"vertical",
		);
		assert.equal(
			pane.element.querySelectorAll(
				".ash-tree-twistie .ash-icon",
			).length,
			1,
		);
		assert.ok(pane.element.querySelector(".ash-tree-indent-guides-onHover"));
		assert.equal(
			pane.element.querySelectorAll(".ash-seti-file-icon").length,
			1,
		);

		const sourceFolder = [...pane.element.querySelectorAll<HTMLButtonElement>(
			".ash-tree-row",
		)].find((row) => rowLabel(row) === "src");
		assert.ok(sourceFolder);
		pauseSourceRead = true;
		const oldSelection = explorerService.select(URI.file('/project/src/main.ts'), 'force');
		await waitFor(() => completeSourceRead !== undefined);
		activeEditor = { resource: URI.file('/project/README.md'), label: 'README.md' };
		activeEditorChanges.fire();
		await waitFor(() => explorerService.getContext()[0]?.name === 'README.md');
		completeSourceRead!();
		await oldSelection;
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		pane.element.querySelector('.ash-tree')!.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		assert.deepEqual(contextMenu?.getActionsContext?.(), []);
		contextMenu?.onHide?.(true);
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		assert.ok(rowLabels(pane.element).includes('main.ts'));
		sourceFolder.querySelector<HTMLElement>('.ash-tree-twistie')?.click();
		activeEditor = undefined;
		activeEditorChanges.fire();
		sourceFolder.click();
		assert.equal(explorerService.getContext()[0]?.resource.toString(), URI.file('/project/src').toString());

		await waitFor(() => rowLabels(pane.element).includes("main.ts"));
		assert.equal(hoverCreations, 3);
		const mainRow = [...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'main.ts');
		assert.ok(mainRow);
		const readmeRow = [...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'README.md');
		assert.ok(readmeRow);
		assert.equal(mainRow.querySelector('.ash-icon-label-description'), null);
		assert.equal(mainRow.querySelector('.ash-icon-label')?.getAttribute('aria-label'), isWindows ? 'src\\main.ts' : 'src/main.ts');
		assert.equal(sourceFolder.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-with-icon-gap'), true);
		assert.equal(readmeRow.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-hidden'), true);
		assert.equal(mainRow.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-hidden'), true);
		assert.equal(sourceFolder.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-hidden'), false);
		fileIconTheme = { ...noFileIconTheme };
		iconChanges.fire();
		assert.equal(readmeRow.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-hidden'), false);
		fileIconTheme = { ...noFileIconTheme, hasFileIcons: true, hidesExplorerArrows: true };
		iconChanges.fire();
		assert.equal(sourceFolder.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-hidden'), true);
		fileIconTheme = { ...noFileIconTheme, hasFileIcons: true };
		iconChanges.fire();
		assert.equal(sourceFolder.querySelector('.ash-tree-twistie')?.classList.contains('ash-tree-twistie-hidden'), false);
		assert.equal(readmeRow.isConnected, true);
		mainRow.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }));
		assert.equal(contextMenu?.menuId?.id, 'ExplorerContext');
		assert.equal((contextMenu?.menuActionOptions?.arg as URI).toString(), URI.file('/project/src/main.ts').toString());
		assert.equal(contextMenu?.contextKeyService?.getValue('ashExplorerIsFile'), true);
		assert.equal(contextMenu?.contextKeyService?.getValue('ashExplorerCanModify'), true);
		assert.equal(contextMenu?.contextKeyService?.getValue('ashExplorerCanCreate'), false);
		assert.equal(explorerService.getContext()[0]?.name, 'main.ts');
		readmeRow.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		pane.element.querySelector<HTMLElement>('.ash-tree')?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
		assert.equal(contextMenu?.menuId?.id, 'ExplorerContext');
		sourceFolder.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(contextMenu?.contextKeyService?.getValue('ashExplorerCanCreate'), true);
		assert.equal([...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'src'), sourceFolder);
		sourceFolder.click();
		assert.deepEqual(rowLabels(pane.element), ['src', 'README.md']);
		assert.equal(hoverCreations, 3);
		assert.equal(hoverDisposals, 0);
		assert.equal(pane.element.querySelector('[aria-expanded="false"]'), sourceFolder);
		assert.equal([...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'README.md'), readmeRow);
		sourceFolder.click();
		assert.deepEqual(rowLabels(pane.element), ['src', 'main.ts', 'README.md']);
		assert.equal(hoverCreations, 3);
		assert.equal([...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'main.ts'), mainRow);
		assert.equal([...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'README.md'), readmeRow);
		assert.deepEqual(rowLabels(pane.element), [
			"src",
			"main.ts",
			"README.md",
		]);
		assert.equal(
			pane.element.querySelectorAll(".ash-seti-file-icon").length,
			2,
		);
		assert.deepEqual(directoryReads, [
			root.toString(),
			URI.file("/project/src").toString(),
		]);
		await explorerService.select(URI.file('/project/README.md'), 'force');
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		pane.setVisible(false);
		pane.collapseAll();
		activeEditor = { resource: URI.file('/project/src/main.ts'), label: 'main.ts' };
		activeEditorChanges.fire();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		assert.equal(sourceFolder.getAttribute('aria-expanded'), 'false');
		const focusBeforeReveal = browser.window.document.activeElement;
		pane.setVisible(true);
		await waitFor(() => explorerService.getContext()[0]?.name === 'main.ts');
		assert.equal(sourceFolder.getAttribute('aria-expanded'), 'true');
		assert.equal(mainRow.getAttribute('aria-selected'), 'true');
		assert.equal(browser.window.document.activeElement, focusBeforeReveal);
		pane.setExpanded(false);
		activeEditor = { resource: URI.file('/project/README.md'), label: 'README.md' };
		activeEditorChanges.fire();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(explorerService.getContext()[0]?.name, 'main.ts');
		pane.setExpanded(true);
		await waitFor(() => explorerService.getContext()[0]?.name === 'README.md');
		pane.setVisible(false);
		pane.collapseAll();
		await configurationService.updateValue('explorer.autoReveal', false);
		activeEditor = { resource: URI.file('/project/src/main.ts'), label: 'main.ts' };
		activeEditorChanges.fire();
		pane.setVisible(true);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		assert.equal(sourceFolder.getAttribute('aria-expanded'), 'false');
		pane.setVisible(false);
		await configurationService.updateValue('explorer.autoRevealExclude', { '**/main.ts': true });
		await configurationService.updateValue('explorer.autoReveal', true);
		pane.setVisible(true);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		assert.equal(sourceFolder.getAttribute('aria-expanded'), 'false');
		await configurationService.updateValue('explorer.autoRevealExclude', {});
		await waitFor(() => explorerService.getContext()[0]?.name === 'main.ts');
		activeEditor = undefined;
		activeEditorChanges.fire();
		await explorerService.select(URI.file('/project/src/main.ts'), 'force');
		pane.focus();
		assert.equal(explorerService.getContext()[0]?.name, 'main.ts');
		assert.equal(pane.element.querySelector('.ash-tree')?.getAttribute('aria-activedescendant'), mainRow.id);
		assert.equal(Boolean(openedInput), false);
		const mainLabel = mainRow.querySelector('.ash-icon-label');
		const folderArrow = sourceFolder.querySelector('.ash-tree-twistie .ash-icon');
		const loadingStates: string[] = [];
		const observer = new browser.window.MutationObserver(records => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node instanceof browser.window.Element && node.classList.contains('ash-explorer-tree-loading')) loadingStates.push('loading');
				}
			}
		});
		observer.observe(pane.element, { childList: true, subtree: true });
		const editorFocusTarget = browser.window.document.createElement('textarea');
		browser.window.document.body.append(editorFocusTarget);
		try {
			editorFocusTarget.focus();
			for (const resource of [URI.file('/project/README.md'), URI.file('/project/src/main.ts'), URI.file('/project/README.md'), URI.file('/project/src/main.ts')]) {
				directoryReads.length = 0;
				activeEditor = { resource, label: resource.path.split('/').at(-1)! };
				activeEditorChanges.fire();
				await waitFor(() => explorerService.getContext()[0]?.resource.toString() === resource.toString());
				const selectedRow = pane.element.querySelector<HTMLElement>(`[data-tree-id="${resource.toString()}"]`);
				assert.equal(pane.element.querySelector('.ash-tree')?.getAttribute('aria-activedescendant'), selectedRow?.id);
				assert.deepEqual(directoryReads, []);
				assert.equal(mainRow.querySelector('.ash-icon-label'), mainLabel);
				assert.equal(sourceFolder.querySelector('.ash-tree-twistie .ash-icon'), folderArrow);
				assert.equal(browser.window.document.activeElement, editorFocusTarget);
			}
			pane.focus();
			pane.element.querySelector('.ash-tree')?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
			assert.equal(explorerService.getContext()[0]?.name, 'README.md');
			const treeElement = pane.element.querySelector<HTMLElement>('.ash-tree')!;
			treeElement.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'm' }));
			assert.equal(treeElement.getAttribute('aria-activedescendant'), mainRow.id);
			activeEditor = { resource: URI.file('/project/README.md'), label: 'README.md' };
			activeEditorChanges.fire();
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(treeElement.getAttribute('aria-activedescendant'), mainRow.id);
			assert.equal(explorerService.getContext()[0]?.name, 'README.md');
			assert.deepEqual(loadingStates, []);
			sourceFolder.querySelector<HTMLElement>('.ash-tree-twistie')?.click();
			directoryReads.length = 0;
			await explorerService.select(URI.file('/project/src/main.ts'), 'force');
			assert.deepEqual(directoryReads, []);
			assert.equal(sourceFolder.getAttribute('aria-expanded'), 'true');
			assert.equal(mainRow.querySelector('.ash-icon-label'), mainLabel);
			assert.deepEqual(loadingStates, []);
		} finally {
			editorFocusTarget.remove();
			observer.disconnect();
		}
		await explorerService.select(URI.file('/project/README.md'), 'force');
		activeEditor = undefined;
		activeEditorChanges.fire();
		await configurationService.updateValue('explorer.autoRevealExclude', { '**/*.ts': { when: 'main.ts' } });
		sourceFolder.querySelector<HTMLElement>('.ash-tree-twistie')?.click();
		await explorerService.select(URI.file('/project/README.md'), 'force');
		directoryReads.length = 0;
		activeEditor = { resource: URI.file('/project/src/main.ts'), label: 'main.ts' };
		activeEditorChanges.fire();
		// All fixture reads resolve immediately; finish the event turn before checking a suppressed reveal.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(directoryReads, []);
		assert.equal(sourceFolder.getAttribute('aria-expanded'), 'false');
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		for (let attempt = 0; attempt < 2; attempt++) {
			activeEditorChanges.fire();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(directoryReads, []);
			assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		}
		{
			let receivedChange = (): void => { };
			const change = new Promise<void>(resolve => { receivedChange = resolve; });
			using listener = explorerService.onDidChangeResources(() => receivedChange());
			fileChanges.fire({ resources: [URI.file('/project/src/main.ts')] });
			await change;
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(directoryReads, []);
			activeEditorChanges.fire();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
			assert.equal(sourceFolder.getAttribute('aria-expanded'), 'false');
			assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		}
		directoryReads.length = 0;
		await configurationService.updateValue('explorer.autoRevealExclude', { '**/*.ts': { when: 'missing.ts' } });
		await waitFor(() => explorerService.getContext()[0]?.name === 'main.ts');
		assert.deepEqual(directoryReads, []);
		await explorerService.select(URI.file('/project/README.md'), 'force');
		activeEditor = undefined;
		activeEditorChanges.fire();
		await configurationService.updateValue('explorer.autoRevealExclude', { '**/*.js': { when: 'main.ts' } });
		directoryReads.length = 0;
		activeEditor = { resource: URI.file('/project/src/main.ts'), label: 'main.ts' };
		activeEditorChanges.fire();
		await waitFor(() => explorerService.getContext()[0]?.name === 'main.ts');
		assert.deepEqual(directoryReads, []);
		activeEditor = undefined;
		activeEditorChanges.fire();
		await configurationService.updateValue('explorer.autoRevealExclude', {});
		addedNestedFile = true;
		directoryReads.length = 0;
		await explorerService.select(URI.file('/project/src/nested.ts'), 'force');
		assert.equal(explorerService.getContext()[0]?.name, 'nested.ts');
		assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
		await configurationService.updateValue(ExplorerFileNestingSettingId.Patterns, { 'main.ts': 'nested.ts' });
		await configurationService.updateValue(ExplorerFileNestingSettingId.Enabled, true);
		await waitFor(() => pane.element.querySelector('[data-tree-id="file:///project/src/main.ts"]')?.getAttribute('aria-expanded') === 'true');
		const nestedGroup = pane.element.querySelector<HTMLElement>('[data-tree-id="file:///project/src/main.ts"]');
		assert.ok(nestedGroup);
		nestedGroup.querySelector<HTMLElement>('.ash-tree-twistie')?.click();
		await explorerService.select(URI.file('/project/README.md'), 'force');
		await configurationService.updateValue('explorer.autoRevealExclude', { '**/main.ts': { when: 'nested.ts' } });
		directoryReads.length = 0;
		activeEditor = { resource: URI.file('/project/src/main.ts'), label: 'main.ts' };
		activeEditorChanges.fire();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(directoryReads, []);
		assert.equal(explorerService.getContext()[0]?.name, 'README.md');
		assert.equal(nestedGroup.getAttribute('aria-expanded'), 'false');
		activeEditor = undefined;
		activeEditorChanges.fire();
		await configurationService.updateValue('explorer.autoRevealExclude', {});
		await explorerService.select(URI.file('/project/src/nested.ts'), 'force');
		directoryReads.length = 0;
		await explorerService.select(URI.file('/project/src/missing.ts'), 'force');
		assert.equal(explorerService.getContext()[0]?.name, 'nested.ts');
		assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
		addedNestedFile = false;
		{
			let receivedChange = (): void => { };
			const change = new Promise<void>(resolve => { receivedChange = resolve; });
			using listener = explorerService.onDidChangeResources(() => receivedChange());
			fileChanges.fire({ resources: [URI.file('/project/src')] });
			await change;
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(rowLabels(pane.element).includes('nested.ts'), false, JSON.stringify({ rows: rowLabels(pane.element), reads: directoryReads, error: pane.element.querySelector('.ash-explorer-error')?.textContent }));
		}
		await configurationService.updateValue(ExplorerFileNestingSettingId.Enabled, false);
		await new Promise<void>(resolve => setImmediate(resolve));
		sourceFolder.click();
		await configurationService.updateValue(ListConfiguration.treeExpandMode, "doubleClick");
		sourceFolder.click();
		assert.equal(sourceFolder.getAttribute("aria-expanded"), "false");
		assert.deepEqual(rowLabels(pane.element), ["src", "README.md"]);
		sourceFolder.dispatchEvent(new browser.window.MouseEvent("click", { bubbles: true, button: 0, detail: 2 }));
		const expandedSourceFolder = [...pane.element.querySelectorAll<HTMLElement>(".ash-tree-row")].find(row => rowLabel(row) === "src");
		assert.ok(expandedSourceFolder);
		expandedSourceFolder.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
		assert.equal(sourceFolder.getAttribute("aria-expanded"), "true");
		assert.deepEqual(rowLabels(pane.element), ["src", "main.ts", "README.md"]);

		const readme = [...pane.element.querySelectorAll<HTMLButtonElement>(
			".ash-tree-row",
		)].find((row) => rowLabel(row) === "README.md");
		assert.ok(readme);
		readme.click();
		await waitFor(() => openedInput !== undefined);
		assert.equal(openedInput?.label, "README.md");
		assert.equal(openedInput?.initialText, undefined);
		assert.equal(
			openedInput?.resource.toString(),
			URI.file("/project/README.md").toString(),
		);
		assert.deepEqual(openedOptions, { pinned: false, preserveFocus: true, source: EditorOpenSource.USER });
		assert.equal(openedTarget, "activeGroup");
		assert.equal(editorFocusCount, 0);

		readme.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
		await waitFor(() => editorFocusCount === 1);
		assert.deepEqual(openedOptions, { pinned: true, preserveFocus: false, source: EditorOpenSource.USER });
		const treeElement = pane.element.querySelector<HTMLElement>('.ash-tree');
		assert.ok(treeElement);
		treeElement.focus();
		assert.equal(browser.window.document.activeElement, treeElement);
		directoryReads.length = 0;
		addedRootFile = true;
		const refreshButton = pane.element.querySelector<HTMLButtonElement>('[data-action-id="workbench.files.action.refreshFilesExplorer"] button');
		assert.ok(refreshButton);
		refreshButton.click();
		await waitFor(() => rowLabels(pane.element).includes("new.txt"));
		assert.deepEqual(directoryReads, [root.toString(), URI.file('/project/src').toString()]);
		assert.equal(browser.window.document.activeElement, treeElement);
		assert.deepEqual(rowLabels(pane.element), ["src", "main.ts", "new.txt", "README.md"]);
		directoryReads.length = 0;
		addedNestedFile = true;
		fileChanges.fire({ resources: [URI.file('/project/src/nested.ts')] });
		await waitFor(() => rowLabels(pane.element).includes('nested.ts'));
		assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
		assert.deepEqual(rowLabels(pane.element), ['src', 'main.ts', 'nested.ts', 'new.txt', 'README.md']);
		directoryReads.length = 0;
		fileChanges.fire({ resources: [URI.file('/project/src')] });
		await waitFor(() => directoryReads.length === 2);
		assert.deepEqual(directoryReads, [root.toString(), URI.file('/project/src').toString()]);
		directoryReads.length = 0;
		fileChanges.fire({ resources: undefined });
		await waitFor(() => directoryReads.length === 2);
		assert.deepEqual(directoryReads, [root.toString(), URI.file('/project/src').toString()]);
		failNextRootRead = true;
		fileChanges.fire({ resources: [root] });
		await waitFor(() => pane.element.querySelector(".ash-explorer-error")?.textContent === "Workspace files are temporarily unavailable");
		fileChanges.fire({ resources: [root] });
		await waitFor(() => pane.element.querySelector(".ash-explorer-error") === null);
		assert.deepEqual(rowLabels(pane.element), ['src', 'main.ts', 'nested.ts', 'new.txt', 'README.md']);

		directoryReads.length = 0;
		fileChanges.fire({ resources: [URI.file('/project/src/main.ts')] });
		fileChanges.fire({ resources: [URI.file('/project/src/nested.ts')] });
		await waitFor(() => directoryReads.length > 0);
		assert.deepEqual({ reads: directoryReads, stats: metadataChecks }, { reads: [URI.file('/project/src').toString()], stats: [] });
		directoryReads.length = 0;
		fileChanges.fire({ resources: [URI.file('/project/src/main.ts')] });
		await waitFor(() => metadataChecks.length === 1);
		assert.deepEqual(directoryReads, []);
		assert.equal(browser.window.document.activeElement, treeElement);

		pane.collapseAll();
		addedNestedFile = false;
		let receivedFoldedChange = (): void => { };
		const foldedChange = new Promise<void>(resolve => { receivedFoldedChange = resolve; });
		using foldedChangeListener = explorerService.onDidChangeResources(() => receivedFoldedChange());
		fileChanges.fire({ resources: [URI.file('/project/src/nested.ts'), URI.file('/project/src/deep/hidden.ts')] });
		await foldedChange;
		await Promise.resolve();
		assert.deepEqual(directoryReads, []);
		expandedSourceFolder.querySelector<HTMLElement>('.ash-tree-twistie')?.click();
		await waitFor(() => rowLabels(pane.element).includes('main.ts'));
		assert.deepEqual({ reads: directoryReads, labels: rowLabels(pane.element) }, {
			reads: [URI.file('/project/src').toString()], labels: ['src', 'main.ts', 'new.txt', 'README.md'],
		});

		directoryReads.length = 0;
		mainExists = false;
		fileChanges.fire({ resources: [URI.file('/project/src/main.ts')] });
		await waitFor(() => !rowLabels(pane.element).includes('main.ts'));
		assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
		directoryReads.length = 0;
		mainExists = true;
		mainKind = FileKind.Directory;
		fileChanges.fire({ resources: [URI.file('/project/src/main.ts')] });
		await waitFor(() => pane.element.querySelector('[data-tree-id="file:///project/src/main.ts"]')?.getAttribute('aria-expanded') === 'false');
		assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
		directoryReads.length = 0;
		sourceExists = false;
		fileChanges.fire({ resources: [URI.file('/project/src')] });
		await waitFor(() => !rowLabels(pane.element).includes('src'));
		assert.deepEqual({ reads: directoryReads, error: pane.element.querySelector('.ash-explorer-error') }, { reads: [root.toString()], error: null });

		workspaceContextService.updateWorkspace({
			id: "next-workspace",
			uri: nextRoot,
		});
		await waitFor(() =>
			pane.element.querySelector(".ash-pane-view-header-title")?.textContent ===
			"next-project" &&
			rowLabels(pane.element).includes("next.txt")
		);
		assert.deepEqual(rowLabels(pane.element), ["link", "next.txt", "unknown"]);
		const decoratedRows = [...pane.element.querySelectorAll<HTMLElement>(".ash-tree-row")];
		assert.equal(decoratedRows[0]?.querySelector(".ash-icon-label-suffix")?.textContent, "↷");
		assert.equal(decoratedRows[0]?.querySelector(".ash-icon-label")?.getAttribute("aria-label"), "link, Symbolic Link");
		assert.equal(decoratedRows[1]?.querySelector(".ash-icon-label-suffix"), null);
		assert.equal(decoratedRows[2]?.querySelector(".ash-icon-label-suffix")?.textContent, "?");
		assert.equal(decoratedRows[2]?.querySelector(".ash-icon-label")?.getAttribute("aria-label"), "unknown, Unknown File Type");
		using decorationRegistration = decorations.registerDecorationsProvider({ label: 'Test status', onDidChange: Event.None, provideDecorations: resource => resource.path === '/next-project/next.txt' ? { color: 'gitDecoration.modifiedResourceForeground', letter: 'M' } : undefined });
		const nextLabel = () => [...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'next.txt')?.querySelector<HTMLElement>('.ash-icon-label');
		await waitFor(() => nextLabel()?.className.includes('-color') === true);
		await configurationService.updateValue('explorer.decorations.colors', false);
		await waitFor(() => nextLabel()?.className.includes('-color') === false);
		await configurationService.updateValue('explorer.decorations.badges', false);
		await waitFor(() => pane.element.querySelectorAll('.ash-icon-label-suffix').length === 0 && nextLabel()?.className.includes('-badge') === false);
		assert.equal([...pane.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => rowLabel(row) === 'link')?.querySelector('.ash-icon-label')?.getAttribute('aria-label'), 'link, Symbolic Link');
		await configurationService.updateValue('files.exclude', { '**/next.txt': true });
		await waitFor(() => !rowLabels(pane.element).includes('next.txt'));
		await configurationService.updateValue('files.exclude', {});
		await waitFor(() => rowLabels(pane.element).includes('next.txt'));
	} finally {
		browser.window.close();
		for (const name of installedGlobals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

function testManagedHover(onDispose?: () => void): IManagedHover {
	return {
		visible: false,
		show() { },
		hide() { },
		update() { },
		dispose() { onDispose?.(); },
		[Symbol.dispose]() { onDispose?.(); },
	};
}

function rowLabels(container: Element): readonly string[] {
	return [...container.querySelectorAll<HTMLElement>(
		".ash-tree-row",
	)].map(rowLabel);
}

function rowLabel(row: Element): string {
	return row.querySelector(".ash-icon-label-text")?.textContent ?? "";
}

async function waitFor(
	condition: () => boolean,
	timeoutMillis = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for ExplorerView");
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		KeyboardEvent: browser.window.KeyboardEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
		});
	}
	return Object.keys(globals);
}
