import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { FileKind, type IFileService } from "../../../../../platform/files/common/files.js";
import { WorkspaceContextService } from "../../../../../workbench/services/workspaces/browser/workspaceContextService.js";
import type { IFileIconThemeService } from "../../../../../platform/theme/browser/fileIconThemeService.js";
import type { IHoverService, IManagedHover } from "../../../../../platform/hover/common/hoverService.js";
import { ListConfiguration } from "../../../../../platform/list/common/listConfiguration.js";
import type { EditorInput, EditorOpenOptions, EditorOpenTarget, IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

test("ExplorerViewPane opens workspace files on single click", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const root = URI.file("C:\\project");
	const nextRoot = URI.file("C:\\next-project");
	const directoryReads: string[] = [];
	let openedInput: EditorInput | undefined;
	let openedOptions: EditorOpenOptions | undefined;
	let openedTarget: EditorOpenTarget | undefined;
	let editorFocusCount = 0;
	const fileService: IFileService = {
		onDidChangeFiles: () => ({
			dispose() {},
			[Symbol.dispose]() {},
		}),
		stat: async (resource) => ({
			resource,
			kind: FileKind.Directory,
			sizeBytes: 0,
			readonly: false,
			modifiedAtMillis: undefined,
		}),
		readDirectory: async (resource) => {
			directoryReads.push(resource.toString());
			if (resource.toString() === root.toString()) {
				return [
					{
						resource: URI.file("C:\\project\\README.md"),
						name: "README.md",
						kind: FileKind.File,
					},
					{
						resource: URI.file("C:\\project\\src"),
						name: "src",
						kind: FileKind.Directory,
					},
				];
			}
			if (resource.toString() === nextRoot.toString()) {
				return [{
					resource: URI.file("C:\\next-project\\next.txt"),
					name: "next.txt",
					kind: FileKind.File,
				}];
			}
			return [{
				resource: URI.file("C:\\project\\src\\main.ts"),
				name: "main.ts",
				kind: FileKind.File,
			}];
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
		createFile: async () => { throw new Error("Explorer must not create files in this test"); },
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
	const fileIconThemeService: IFileIconThemeService = {
		onDidFileIconThemeChange: () => ({
			dispose() {},
			[Symbol.dispose]() {},
		}),
		renderFileIcon: (resource, container) => {
			container.classList.add("ash-seti-file-icon");
			container.textContent = resource.path.endsWith(".ts") ? "T" : "F";
		},
	};
	const hoverService: IHoverService = {
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() {},
	};

	try {
		const { ExplorerViewPane } = await import(
			"../../../../../workbench/contrib/files/browser/explorerViewPane.js"
		);
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

		using pane = new ExplorerViewPane(
			browser.window.document.body,
			{
				id: "ash.explorer",
				title: "Explorer",
			},
			fileService,
			workspaceContextService,
			editorService,
			fileIconThemeService,
			hoverService,
			configurationService,
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
		assert.equal(
			pane.element.querySelector(
				".ash-explorer > .ash-scrollable-element",
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

		await waitFor(() => rowLabels(pane.element).includes("main.ts"));
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
			URI.file("C:\\project\\src").toString(),
		]);

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
			URI.file("C:\\project\\README.md").toString(),
		);
		assert.deepEqual(openedOptions, { pinned: false, preserveFocus: true });
		assert.equal(openedTarget, "activeGroup");
		assert.equal(editorFocusCount, 0);

		readme.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
		await waitFor(() => editorFocusCount === 1);
		assert.deepEqual(openedOptions, { pinned: true, preserveFocus: false });

		workspaceContextService.updateWorkspace({
			id: "next-workspace",
			uri: nextRoot,
		});
		await waitFor(() =>
			pane.element.querySelector(".ash-pane-view-header-title")?.textContent ===
				"next-project" &&
			rowLabels(pane.element).includes("next.txt")
		);
		assert.deepEqual(rowLabels(pane.element), ["next.txt"]);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

function testManagedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
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
			throw new Error("Timed out waiting for ExplorerViewPane");
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
