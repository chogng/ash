import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { Emitter } from "../../../../../base/common/event.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { FileKind, type IFileService } from "../../../../../platform/files/common/files.js";
import { WorkspaceContextService } from "../../../../../workbench/services/workspaces/browser/workspaceContextService.js";
import type { IResourceIconRenderer } from "../../../../browser/labels.js";
import type { IHoverService, IManagedHover } from "../../../../../platform/hover/browser/hoverService.js";
import { ListConfiguration } from "../../../../../platform/list/common/listConfiguration.js";
import type { EditorInput, EditorOpenOptions, EditorOpenTarget, IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
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
	using fileChanges = new Emitter<{ readonly resources: readonly URI[] | undefined }>();
	let addedRootFile = false;
	let addedNestedFile = false;
	let failNextRootRead = false;
	let openedInput: EditorInput | undefined;
	let openedOptions: EditorOpenOptions | undefined;
	let openedTarget: EditorOpenTarget | undefined;
	let editorFocusCount = 0;
	let hoverCreations = 0;
	let hoverDisposals = 0;
	let contextMenu: IContextMenuMenuDelegate | undefined;
	const fileService: IFileService = {
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
		readFileBytes: async (_resource) => {
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
	using workspaceContextService = new WorkspaceContextService({
		id: "workspace",
		uri: root,
	});
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor: async (input: EditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget) => {
			openedInput = input;
			openedOptions = options;
			openedTarget = target;
			if (options?.preserveFocus !== true) editorFocusCount += 1;
		},
		focusActiveEditor() { editorFocusCount += 1; },
	};
	using configurationService = new InMemoryConfigurationService();
	await configurationService.updateValue(ListConfiguration.openMode, "doubleClick");
	const resourceIconRenderer: IResourceIconRenderer = {
		onDidChangeResourceIcons: () => ({
			dispose() {},
			[Symbol.dispose]() {},
		}),
		renderFileIcon: (resource, container) => {
			container.classList.add("ash-seti-file-icon");
			container.textContent = resource.path.endsWith(".ts") ? "T" : "F";
		},
	};
	const hoverService: IHoverService = {
		setupHover: () => {
			hoverCreations += 1;
			return testManagedHover(() => { hoverDisposals += 1; });
		},
		showHover: () => testManagedHover(),
		hideHover() {},
	};

	try {
		const { ExplorerView } = await import(
			"../../../../../workbench/contrib/files/browser/views/explorerView.js"
		);
		const { ExplorerService } = await import('../../browser/explorerService.js');
		using explorerService = new ExplorerService(workspaceContextService, fileService);
		using contextKeyService = new ContextKeyService();
		const accessibleViewService: IAccessibleViewService = {
			show: () => false,
			getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.',
			dispose() {},
			[Symbol.dispose]() {},
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
				openWorkspace: async () => {},
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
		assert.ok(pane.element.querySelector(".ash-tree-indent-guides-always"));
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
		assert.deepEqual(openedOptions, { pinned: false, preserveFocus: true });
		assert.equal(openedTarget, "activeGroup");
		assert.equal(editorFocusCount, 0);

		readme.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
		await waitFor(() => editorFocusCount === 1);
		assert.deepEqual(openedOptions, { pinned: true, preserveFocus: false });
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
		show() {},
		hide() {},
		update() {},
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
