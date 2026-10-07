import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { noFileIconTheme } from '../../../../../platform/theme/common/themeService.js';
import { EditorOpenSource } from '../../../../../platform/editor/common/editor.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { isWindows } from '../../../../../base/common/platform.js';
import { Emitter } from "../../../../../base/common/event.js";
import { DecorationsService } from '../../../../services/decorations/browser/decorationsService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { FileKind, type IFileSystemProvider } from "../../../../../platform/files/common/files.js";
import { WorkspaceContextService } from "../../../../../workbench/services/workspaces/browser/workspaceContextService.js";
import type { IResourceIconRenderer } from "../../../../browser/labels.js";
import type { IHoverService, IManagedHover } from "../../../../../platform/hover/browser/hoverService.js";
import { ListConfiguration } from "../../../../../platform/list/browser/listService.js";
import type { EditorOpenOptions, EditorOpenTarget, IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IContextMenuMenuDelegate, IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';

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
	using fileChanges = new Emitter<{ readonly resources: readonly URI[] | undefined; }>();
	let addedRootFile = false;
	let addedNestedFile = false;
	let failNextRootRead = false;
	let openedInput: IResourceEditorInput | undefined;
	let openedOptions: EditorOpenOptions | undefined;
	let openedTarget: EditorOpenTarget | undefined;
	let editorFocusCount = 0;
	let hoverCreations = 0;
	let hoverDisposals = 0;
	let contextMenu: IContextMenuMenuDelegate | undefined;
	const fileProvider: IFileSystemProvider = {
		onDidChangeFiles: fileChanges.event,
		stat: async () => { throw new Error('Explorer must load the workspace root with one directory read'); },
		readDirectory: async (resource) => {
			directoryReads.push(resource.toString());
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
					{
						resource: URI.file("/project/src"),
						name: "src",
						kind: FileKind.Directory,
					},
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
			return [{
				resource: URI.file("/project/src/main.ts"),
				name: "main.ts",
				kind: FileKind.File,
			}, ...(addedNestedFile ? [{
				resource: URI.file('/project/src/nested.ts'),
				name: 'nested.ts',
				kind: FileKind.File,
			}] : [])];
		},
		readFile: async (_resource) => {
			throw new Error("Explorer must delegate file content resolution to the selected editor");
		},
		writeFile: async (_request) => {
			throw new Error("Explorer must delegate file writes to the selected editor");
		},
		writeFileBytes: async () => { throw new Error('File paste is not used in this test'); },
		createFile: async () => { throw new Error("Explorer must not create files in this test"); },
		createDirectory: async () => { throw new Error("Explorer must not create directories in this test"); },
		copy: async () => { throw new Error("Copy is not used in this test"); },
		rename: async () => { throw new Error("Explorer must not rename files in this test"); },
		delete: async () => { throw new Error("Explorer must not delete files in this test"); },
	};
	using fileService = createTestFileService(fileProvider);
	using workspaceContextService = new WorkspaceContextService({
		id: "workspace",
		uri: root,
	});
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor: async (input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget) => {
			openedInput = input;
			openedOptions = options;
			openedTarget = target;
			if (options?.preserveFocus !== true) editorFocusCount += 1;
		},
		focusActiveEditor() { editorFocusCount += 1; },
	};
	using configurationService = new InMemoryConfigurationService();
	await configurationService.updateValue(ListConfiguration.openMode, "doubleClick");
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
		using emptyView = new EmptyView(
			browser.window.document.body,
			{
				id: EmptyView.ID,
				title: EmptyView.TITLE,
			},
			{
				canOpenFolder: true,
				canOpenWorkspace: true,
				openFolder: async () => {
					folderOpens += 1;
				},
				openWorkspace: async () => { },
				pickFolder: async () => undefined,
			},
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
			hoverService,
			configurationService,
			explorerService,
			{} as IInstantiationService,
			contextKeyService,
			accessibleViewService,
			{ showContextMenu: delegate => { contextMenu = delegate as IContextMenuMenuDelegate; } } as IContextMenuService,
			{ executeCommand: async () => undefined } as unknown as ICommandService,
			decorations,
		);
		browser.window.document.body.append(pane.element);
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
		await explorerService.select(URI.file('/project/src/main.ts'), 'force');
		pane.focus();
		assert.equal(explorerService.getContext()[0]?.name, 'main.ts');
		assert.equal(pane.element.querySelector('.ash-tree')?.getAttribute('aria-activedescendant'), mainRow.id);
		assert.equal(Boolean(openedInput), false);
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
		fileChanges.fire({ resources: [URI.file("/project/new.txt")] });
		await waitFor(() => rowLabels(pane.element).includes("new.txt"));
		assert.deepEqual(directoryReads, [root.toString()]);
		assert.equal(browser.window.document.activeElement, treeElement);
		assert.deepEqual(rowLabels(pane.element), ["src", "main.ts", "README.md", "new.txt"]);
		directoryReads.length = 0;
		addedNestedFile = true;
		fileChanges.fire({ resources: [URI.file('/project/src/nested.ts')] });
		await waitFor(() => rowLabels(pane.element).includes('nested.ts'));
		assert.deepEqual(directoryReads, [URI.file('/project/src').toString()]);
		assert.deepEqual(rowLabels(pane.element), ['src', 'main.ts', 'nested.ts', 'README.md', 'new.txt']);
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
		assert.deepEqual(rowLabels(pane.element), ['src', 'main.ts', 'nested.ts', 'README.md', 'new.txt']);

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
