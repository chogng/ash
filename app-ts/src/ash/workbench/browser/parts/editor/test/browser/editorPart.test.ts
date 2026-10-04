import { WorkbenchWindowBarHeight } from '../../../workbenchPartDimensions.js';
import { EditorInputSerializerRegistry } from '../../../../../services/editor/common/editorInputSerializer.js';
import { Dimension } from '../../../../../../base/browser/dom.js';
import { createTestEditorServices } from '../../../../../test/common/testEditorServices.js';
import type { IEditorPartOptions } from '../../editorPart.js';
import Severity from '../../../../../../base/common/severity.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type {
	IDimension,
} from "../../../../../../base/browser/dom.js";
import { Emitter, Event } from "../../../../../../base/common/event.js";
import type { IAccessibilityService } from "../../../../../../platform/accessibility/common/accessibility.js";
import { BreadcrumbsService } from "../../breadcrumbs.js";
import { AutoLockGroupsConfiguration, DefaultBinaryEditorConfiguration, DynamicEditorConfigurations, DiffEditorAssociationsConfiguration, EditorAssociationsConfiguration, EditorLargeFileConfirmationConfiguration, EditorOpenErrorDialogConfiguration } from "../../editorConfiguration.js";
import { createDiffEditorInput } from "../../../../../common/editor/diffEditorInput.js";
import { InMemoryConfigurationService } from "../../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { FileNotFoundError, type IFileService } from "../../../../../../platform/files/common/files.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../../../platform/registry/common/platform.js";
import {
	Keybinding,
	logicalKey,
	type ResolvedKeybinding,
	resolveKeybinding,
} from "../../../../../../base/common/keybindings.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../../base/common/uri.js";
import { Position } from "../../../../../../editor/common/core/position.js";
import { Range } from "../../../../../../editor/common/core/range.js";
import { EditorOpenSource, TextEditorSelectionSource } from '../../../../../../platform/editor/common/editor.js';
import { createEditorOpenError, EditorInputCapabilities, EditorPaneSelectionChangeReason, type IEditorPaneWithSelection } from '../../../../../../workbench/common/editor.js';
import type { LanguageLocation } from "../../../../../../editor/common/languages.js";
import type {
	CommandId,
} from "../../../../../../platform/commands/common/commands.js";
import { type Context } from "../../../../../../platform/contextkey/common/contextkey.js";
import { MenuId } from "../../../../../../platform/actions/common/actions.js";
import { MenuService } from "../../../../../../platform/actions/common/menuService.js";
import { IEditorGroupsService } from "../../../../../services/editor/common/editorGroupsService.js";
import { ContextKeyService, IContextKeyService } from "../../../../../../platform/contextkey/browser/contextKeyService.js";
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { highContrastDarkColorTheme, lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../../platform/storage/common/storage.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { BrowserStorageService } from '../../../../../../workbench/services/storage/browser/storageService.js';
import { CommandService } from '../../../../../../workbench/services/commands/common/commandService.js';
import { IHistoryService } from '../../../../../../workbench/services/history/common/history.js';
import {
	IKeybindingService,
} from "../../../../../../platform/keybinding/common/keybinding.js";
import {
	ConfirmResult,
	DialogResult,
	type IDialogService,
	type IFileDialogService,
} from "../../../../../../platform/dialogs/common/dialogs.js";
import type {
	EditorInput,
} from "../../../../../../workbench/browser/parts/editor/editorInput.js";
import {
	EditorPaneMatch,
	EditorPaneVisibility,
	type IEditorPane,
} from "../../../../../../workbench/browser/parts/editor/editorPane.js";
import type { IEditorPaneWithViewState } from "../../../../../../workbench/browser/parts/editor/editorWithViewState.js";
import { EditorPaneRegistry, EditorPanes, type IEditorPaneDescriptor } from "../../../../editor.js";
import { ActiveEditorContext } from "../../../../../../workbench/common/contextkeys.js";
import { h, isHTMLElement } from "../../../../../../base/browser/dom.js";
import type { IWorkingCopy } from "../../../../../../workbench/services/workingCopy/common/workingCopyService.js";
import { TextFileBinaryError } from "../../../../../../workbench/services/textfile/common/textFileService.js";
import type {
	AuxiliaryWindowBeforeUnloadEvent,
	AuxiliaryWindowOpenOptions,
	IAuxiliaryWindow,
	IAuxiliaryWindowService,
} from "../../../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const {
	EditorOpenSupersededError,
	EditorPart,
	IEditorPart,
} = await import(
	"../../../../../../workbench/browser/parts/editor/editorPart.js"
);
const { EditorContextKeyController } = await import(
	'../../../../../../workbench/browser/parts/editor/editorContextKeys.js'
);
const { WorkbenchConfiguration } = await import('../../../../../common/configuration.js');

const { createTestWorkbenchContextKeysHandler } = await import('../../../../../../workbench/test/common/testWorkbenchContextKeys.js');
const {
	EditorGroupWatermarkEntries,
} = await import(
	"../../../../../../workbench/browser/parts/editor/editorGroupWatermark.js"
);
const { SplitEditorHorizontalCommandId } = await import(
	"../../../../../../workbench/browser/parts/editor/editorActions.js"
);
const { BrowserEditorService } = await import("../../../../../../workbench/services/editor/browser/browserEditorService.js");
const { HistoryService } = await import("../../../../../../workbench/services/history/browser/historyService.js");
const { GoFilter } = await import('../../../../../../workbench/services/history/common/history.js');
const { EditorParts } = await import("../../../../../../workbench/browser/parts/editor/editorParts.js");
const { BrowserAuxiliaryWindowService } = await import("../../../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js");
await import(
	"../../../../../../workbench/contrib/preferences/browser/preferences.contribution.js"
);
await import('../../../../../../workbench/browser/workbench.contribution.js');

const editorTestServices = new DisposableStore();
suiteTeardown(() => { editorTestServices.dispose(); browserEnvironment.window.close(); });

function createEditorPart(container: HTMLElement, options: IEditorPartOptions, parent?: InstantiationService): InstanceType<typeof EditorPart> {
	const services = editorTestServices.add(createTestEditorServices(options.configurationService, parent));
	return services.createInstance(EditorPart, container, options);
}

/** Editor lifecycle tests use fixed window chrome; title calculation is exercised in the title service suite. */
function createAuxiliaryPart(container: HTMLElement, registry: EditorPaneRegistry) {
	const element = container.ownerDocument.createElement('section');
	container.prepend(element);
	const titlebar = {
		container: element,
		element,
		height: WorkbenchWindowBarHeight,
		minimumWidth: 0,
		maximumWidth: Infinity,
		minimumHeight: WorkbenchWindowBarHeight,
		maximumHeight: WorkbenchWindowBarHeight,
		onDidChange: Event.None, onMenubarVisibilityChange: Event.None,
		layout() {}, updateOptions() {}, updateProperties() {}, registerVariables() {},
		dispose() { element.remove(); },
		[Symbol.dispose]() { this.dispose(); },
	};
	return { part: createEditorPart(container, { registry }), titlebar };
}

test('inactive editor opens keep the selected tab and its content visible', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const panes: TestEditorPane[] = [];
	const registry = new EditorPaneRegistry();
	using registration = registry.registerEditorPane(descriptor('ash.test.inactive', '.ts', () => trackPane(panes, 'ash.test.inactive')));
	using editor = createEditorPart(dom.window.document.body, { registry });
	const first = input('C:/project/first.ts');
	const second = input('C:/project/second.ts');
	await editor.openEditor(first);
	await editor.openEditor(second, { inactive: true, pinned: true, preserveFocus: true });
	assert.equal(editor.activeInput, first);
	assert.equal(panes[1]!.visibilities.at(-1), EditorPaneVisibility.Hidden);
	await editor.openEditor(second);
	assert.equal(editor.activeInput, second);
	assert.equal(panes[1]!.visibilities.at(-1), EditorPaneVisibility.Visible);
	dom.window.close();
});

test('protected tabs reject user closure while lifecycle reset can release them', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	using registration = registry.registerEditorPane(descriptor('ash.test.protected', '.ts', () => new TestEditorPane('ash.test.protected')));
	using editor = createEditorPart(dom.window.document.body, { registry });
	const protectedInput = { ...input('C:/project/protected.ts'), capabilities: EditorInputCapabilities.CannotClose };
	await editor.openEditor(protectedInput);
	assert.equal(await editor.closeEditor(protectedInput), false);
	assert.equal(await editor.activeGroup.closeEditor(protectedInput, { reason: 'close', skipConfirmation: true }), false);
	assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-action-id="ash.tab.close"] button')?.disabled, true);
	assert.equal(await editor.activeGroup.closeEditor(protectedInput, { reason: 'reset', skipConfirmation: true }), true);
	assert.equal(editor.activeInput, undefined);
	dom.window.close();
});

test('hidden editor content keeps newly opened panes hidden and reserves the detail width', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const panes: TestEditorPane[] = [];
	const registry = new EditorPaneRegistry();
	using registration = registry.registerEditorPane(descriptor('ash.test.docked', '.ts', () => trackPane(panes, 'ash.test.docked')));
	using editor = createEditorPart(dom.window.document.body, { registry });
	editor.layout(new Dimension(800, 600));
	await editor.openEditor(input('C:/project/first.ts'));
	const width = panes[0]!.dimension!.width;
	editor.setContentRightInset(200);
	editor.setEditorContentVisible(false);
	await editor.openEditor(input('C:/project/second.ts'));
	assert.equal(panes[1]!.dimension!.width, width - 200);
	assert.equal(panes[1]!.visibilities.at(-1), EditorPaneVisibility.Hidden);
	editor.setEditorContentVisible(true);
	assert.equal(panes[1]!.visibilities.at(-1), EditorPaneVisibility.Visible);
	assert.equal(dom.window.document.querySelectorAll('.ash-editor-pane-host:not([hidden])').length, 1);
	dom.window.close();
});

test('split editors reserve the shared detail column only once', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const panes: TestEditorPane[] = [];
	const registry = new EditorPaneRegistry();
	using registration = registry.registerEditorPane(descriptor('ash.test.splitDock', '.ts', () => trackPane(panes, 'ash.test.splitDock')));
	using editor = createEditorPart(dom.window.document.body, { registry });
	editor.layout(new Dimension(800, 600));
	await editor.openEditor(input('C:/project/first.ts'));
	await editor.splitActiveGroupHorizontal();
	const originalWidth = panes.reduce((width, pane) => width + pane.dimension!.width, 0);
	editor.setContentRightInset(200);
	assert.equal(panes.reduce((width, pane) => width + pane.dimension!.width, 0), originalWidth - 200);
	assert.ok(panes.every(pane => pane.dimension!.width >= 120));
	editor.setContentRightInset(0);
	assert.equal(panes.reduce((width, pane) => width + pane.dimension!.width, 0), originalWidth);
	dom.window.close();
});

test('EditorPart uses presentation borders without reading DOM dimensions', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using configurationService = new InMemoryConfigurationService();
	await configurationService.updateValue(WorkbenchConfiguration.layoutStyle, 'modern');
	using editor = createEditorPart(dom.window.document.body, { configurationService });
	try {
		for (const name of ['offsetWidth', 'clientWidth', 'offsetHeight', 'clientHeight']) {
			Object.defineProperty(editor.domNode, name, { configurable: true, get: () => { throw new Error('Layout must use the supplied dimensions'); } });
		}
		editor.layout({ width: 800, height: 600 });
		const grid = editor.domNode.querySelector<HTMLElement>('.ash-grid .ash-split-view-pane')!;
		assert.deepEqual({ width: grid.style.width, height: grid.style.height }, { width: '798px', height: '598px' });
		Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: 1.25 });
		editor.layout({ width: 800, height: 600 });
		assert.deepEqual({ width: grid.style.width, height: grid.style.height }, { width: '798.4px', height: '598.4px' });
		await configurationService.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
		editor.layout({ width: 800, height: 600 });
		assert.deepEqual({ width: grid.style.width, height: grid.style.height }, { width: '800px', height: '600px' });
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test("editor registry resolves defaults and explicit Open With choices", () => {
	const registry = new EditorPaneRegistry();
	const alpha = descriptor(
		"stanza.editor.code",
		".ts",
		() => new TestEditorPane("stanza.editor.code"),
	);
	const codeBlockEditorWidget = descriptor(
		"ash.editor.codeBlockEditorWidget",
		".md",
		() => new TestEditorPane("ash.editor.codeBlockEditorWidget"),
	);
	const alphaRegistration = registry.registerEditorPane(alpha);
	const codeBlockEditorWidgetRegistration = registry.registerEditorPane(codeBlockEditorWidget);

	const typescript = input("C:\\project\\main.ts");
	const markdown = input("C:\\project\\paper.md");
	assert.equal(registry.getEditorPane(typescript), alpha);
	assert.equal(registry.getEditorPane(markdown), codeBlockEditorWidget);
	assert.deepEqual(registry.getEditorPanesForInput(markdown), [
		codeBlockEditorWidget,
		alpha,
	]);
	assert.equal(
		registry.getEditorPane(markdown, {
			preferredEditorId: "stanza.editor.code",
		}),
		alpha,
	);
	assert.throws(
		() => registry.getEditorPane(markdown, {
			preferredEditorId: "ash.editor.unknown",
		}),
		/Unknown editor pane/,
	);
	assert.throws(
		() => registry.registerEditorPane(alpha),
		/already registered/,
	);

	codeBlockEditorWidgetRegistration.dispose();
	assert.equal(registry.getEditorPane(markdown), alpha);
	alphaRegistration.dispose();
	assert.equal(registry.getEditorPane(markdown), undefined);
});

test("registered editors update binary editor choices", () => {
	using dynamic = new DynamicEditorConfigurations();
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(DefaultBinaryEditorConfiguration);
	const options = configuration?.setting?.valueType === "select" ? configuration.setting.options : undefined;
	assert.ok(options);
	using registration = EditorPanes.registerEditorPane(descriptor("ash.test.dynamicBinary", ".bin", () => new TestEditorPane("ash.test.dynamicBinary")));
	assert.ok(options.some(option => option.value === "ash.test.dynamicBinary"));
	registration.dispose();
	assert.equal(options.some(option => option.value === "ash.test.dynamicBinary"), false);
});

for (const target of ['activeGroup', 'modalGroup'] as const) {
	test(`unregistered inputs report an open error in ${target}`, async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		dom.window.HTMLElement.prototype.scrollTo = () => undefined;
		const registry = new EditorPaneRegistry();
		const resource = input('C:/project/unregistered.txt');
		try {
			using editor = createEditorPart(dom.window.document.body, { registry });
			await assert.rejects(editor.openEditor(resource, { ignoreError: true }, target), /No editor can open/);
			assert.equal(editor.activeInput, undefined);

			const pane = await editor.openEditor(resource, {}, target);
			assert.equal(pane.id, 'workbench.editor.openError');
			assert.equal(editor.activeInput, resource);
			assert.match(dom.window.document.querySelector('.ash-editor-open-error')?.textContent ?? '', /No editor can open/);
		} finally {
			dom.window.close();
		}
	});
}

test("EditorPart chooses a registered editor from file associations", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("ash.test.default", ".ts", () => new TestEditorPane("ash.test.default")));
	registry.registerEditorPane(descriptor("ash.test.associated", ".other", () => new TestEditorPane("ash.test.associated")));
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAssociationsConfiguration, { "*.ts": "ash.test.associated" });
	const editor = createEditorPart(dom.window.document.body, { registry, configurationService: configuration });
	await editor.openEditor(input("C:\\project\\associated.ts"));
	assert.equal(editor.activePane?.id, "ash.test.associated");
	await configuration.updateValue(EditorAssociationsConfiguration, {});
	await editor.openEditor(input("C:\\project\\default.ts"));
	assert.equal(editor.activePane?.id, "ash.test.default");
	editor.dispose();
	dom.window.close();
});

test("EditorPart applies diff editor associations to the modified resource", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("ash.test.defaultDiff", ".unused", () => new TestEditorPane("ash.test.defaultDiff")));
	registry.registerEditorPane(descriptor("ash.test.associatedDiff", ".other", () => new TestEditorPane("ash.test.associatedDiff")));
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(DiffEditorAssociationsConfiguration, { "*.ts": "ash.test.associatedDiff" });
	using contextKeys = new ContextKeyService();
	const editor = createEditorPart(dom.window.document.body, { registry, configurationService: configuration, contextKeyService: contextKeys });
	using editorContexts = new EditorContextKeyController(contextKeys, editor, registry, undefined);
	const modified = { ...input("C:\\project\\new.ts"), languageId: 'typescript' };
	await editor.openEditor(createDiffEditorInput(input("C:\\project\\old.ts"), modified));
	assert.equal(editor.activePane?.id, "ash.test.associatedDiff");
	assert.deepEqual(['resource', 'resourceScheme', 'resourceFilename', 'resourceExtname', 'resourceLangId'].map(key => contextKeys.getValue(key)), [modified.resource.toString(), 'file', 'new.ts', '.ts', 'typescript']);
	editor.dispose();
	dom.window.close();
});

test("EditorPart routes implicit opens away from automatically locked groups", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("ash.test.locked", ".ts", () => new TestEditorPane("ash.test.locked")));
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(AutoLockGroupsConfiguration, { "ash.test.locked": true });
	const editor = createEditorPart(dom.window.document.body, { registry, configurationService: configuration });
	const original = input("C:\\project\\original.ts");
	const next = input("C:\\project\\next.ts");
	await editor.openEditor(original);
	await editor.splitActiveGroupHorizontal();
	assert.equal(editor.activeGroup.isLocked, true);
	assert.equal(editor.activeGroup.domNode.getAttribute("aria-label"), "Editor group, locked");
	assert.equal(editor.activeGroup.domNode.querySelector<HTMLElement>(".ash-editor-group-lock-indicator")?.hidden, false);
	const lockedGroup = editor.activeGroup;
	await editor.openEditor(next);
	assert.notEqual(editor.activeGroup, lockedGroup);
	assert.deepEqual(lockedGroup.inputs, [original]);
	assert.deepEqual(editor.activeGroup.inputs, [original, next]);
	assert.equal(editor.toggleActiveGroupLock(), true);
	assert.equal(editor.activeGroup.isLocked, true);
	const saved = editor.saveWorkingSet("locked-groups");
	assert.equal(editor.toggleActiveGroupLock(), false);
	await editor.applyWorkingSet(saved);
	assert.equal(editor.activeGroup.isLocked, true);
	editor.dispose();
	dom.window.close();
});

test("EditorPart confirms a large file before changing the active editor", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("ash.test.large", ".ts", () => new TestEditorPane("ash.test.large")));
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorLargeFileConfirmationConfiguration, 1);
	const fileService = {
		stat: async (resource: URI) => ({ resource, kind: "file", sizeBytes: 2 * 1024 * 1024, readonly: false, modifiedAtMillis: undefined }),
	} as unknown as IFileService;
	let allow = false;
	const dialogService = { confirm: async () => ({ confirmed: allow }) } as unknown as IDialogService;
	const editor = createEditorPart(dom.window.document.body, { registry, configurationService: configuration, fileService, dialogService });
	const large = input("C:\\project\\large.ts");
	await assert.rejects(editor.openEditor(large), /cancelled/);
	assert.equal(editor.activeInput, undefined);
	allow = true;
	await editor.openEditor(large);
	assert.equal(editor.activeInput, large);
	editor.dispose();
	dom.window.close();
});

test("EditorPart passes Workbench file services to pane factories", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const textFileService = {
		onDidChangeFiles: () => ({
			dispose() {},
			[Symbol.dispose]() {},
		}),
		resolve: async () => {
			throw new Error("not used");
		},
		save: async () => {
			throw new Error("not used");
		},
	};
	const fileService = {} as never;
	let observedTextFileService: unknown;
	let observedFileService: unknown;
	registry.registerEditorPane({
		id: "ash.editor.text-service-test",
		name: "Text Service Test",
		canOpen: () => EditorPaneMatch.Default,
		create: options => {
			observedTextFileService = options.textFileService;
			observedFileService = options.fileService;
			return new TestEditorPane("ash.editor.text-service-test");
		},
	});
	const editor = createEditorPart(dom.window.document.body, {
		registry,
		fileService,
		textFileService,
	});

	await editor.openEditor(input("C:\\project\\main.ts"));

	assert.equal(observedTextFileService, textFileService);
	assert.equal(observedFileService, fileService);
	editor.dispose();
	dom.window.close();
});

test("EditorPart applies empty-editor tips changes without showing them over an editor", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor(
		"stanza.editor.code",
		".ts",
		() => new TestEditorPane("stanza.editor.code"),
	));
	const keybindings = new TestKeybindingService();
	using configuration = new InMemoryConfigurationService();
	using services = new InstantiationService();
	services.registerInstance(IKeybindingService, keybindings);
	services.registerInstance(IConfigurationService, configuration);
	await assert.rejects(configuration.updateValue('workbench.tips.enabled', 'false'), /must be boolean/);
	keybindings.set(
		"test.openEditor",
		Keybinding.single(logicalKey("o", { primaryKey: true })),
	);
	const entry = EditorGroupWatermarkEntries.register({
		id: "test.openEditor",
		label: "Open Editor",
		command: "test.openEditor",
	});
	const editor = createEditorPart(dom.window.document.body, {
		keybindingService: keybindings,
		registry,
	}, services);
	dom.window.document.body.append(editor.domNode);

	assert.match(
		editor.domNode.textContent ?? "",
		/Open Editor.*(?:Ctrl\+|⌘)O/,
	);
	await configuration.updateValue('workbench.tips.enabled', false);
	assert.equal(editor.domNode.querySelector('.ash-editor-group-watermark-shortcuts')?.childElementCount, 0);
	await configuration.updateValue('workbench.tips.enabled', true);
	assert.match(editor.domNode.textContent ?? '', /Open Editor.*(?:Ctrl\+|⌘)O/);
	await editor.openEditor(input("C:\\project\\main.ts"));
	await configuration.updateValue('workbench.tips.enabled', false);
	await configuration.updateValue('workbench.tips.enabled', true);
	assert.equal(
		editor.domNode.querySelector<HTMLElement>(
			".ash-editor-group-watermark-shortcuts",
		)?.hidden,
		true,
	);
	await editor.closeEditor(editor.activeInput!);
	assert.equal(editor.domNode.querySelector<HTMLElement>('.ash-editor-group-watermark-shortcuts')?.hidden, false);
	assert.match(editor.domNode.textContent ?? '', /Open Editor.*(?:Ctrl\+|⌘)O/);

	editor.dispose();
	entry.dispose();
	keybindings.dispose();
	dom.window.close();
});

test("EditorPart saves the active pane through the editor contract", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const pane = new TestEditorPane("ash.editor.save-test");
	registry.registerEditorPane(descriptor(
		"ash.editor.save-test",
		".save",
		() => pane,
	));
	const editor = createEditorPart(dom.window.document.body, { registry });

	await editor.openEditor(input("C:\\project\\document.save"));
	await editor.saveActiveEditor();

	assert.equal(pane.saveCount, 1);
	editor.dispose();
	dom.window.close();
});

test("EditorPart opens cross-resource language targets and reveals their selection", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	let openLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined;
	registry.registerEditorPane({
		id: "ash.editor.navigation-test",
		name: "Navigation Test",
		canOpen: () => EditorPaneMatch.Default,
		create: options => {
			openLocation = options.onOpenLocation!;
			return trackPane(panes, "ash.editor.navigation-test");
		},
	});
	const editor = createEditorPart(dom.window.document.body, { registry });
	await editor.openEditor(input("C:\\project\\main.ts"));
	const target = URI.file("C:\\project\\target.ts");
	const range = Range.fromPositions(new Position((4) + 1, (1) + 1), new Position((4) + 1, (8) + 1));

	await openLocation!({ resource: target, range });

	assert.equal(editor.activeInput?.resource.toString(), target.toString());
	assert.deepEqual(panes[1]?.revealedRanges, [range]);
	const narrower = Range.fromPositions(new Position((4) + 1, (3) + 1), new Position((4) + 1, (7) + 1));
	await openLocation!({ resource: target, range, selectionRange: narrower });
	assert.deepEqual(panes[1]?.revealedRanges, [range, narrower]);
	editor.dispose();
	dom.window.close();
});

test("EditorPart retains tabs and switches loaded panes", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	registry.registerEditorPane(descriptor(
		"stanza.editor.code",
		".ts",
		() => trackPane(panes, "stanza.editor.code"),
	));
	registry.registerEditorPane(descriptor(
		"ash.editor.codeBlockEditorWidget",
		".md",
		() => trackPane(panes, "ash.editor.codeBlockEditorWidget"),
	));
	const editor = createEditorPart(dom.window.document.body, { registry });
	dom.window.document.body.append(editor.domNode);

	const typescript = input("C:/project/main.ts");
	const alphaPane = await editor.openEditor(typescript);
	assert.equal(editor.groups.length, 1);
	assert.equal(editor.activeGroup, editor.groups[0]);
	assert.equal(editor.activePane, alphaPane);
	assert.equal(editor.activeInput, typescript);
	assert.deepEqual(editor.activeGroup.inputs, [typescript]);
	assert.equal(
		editor.domNode.querySelector(
			".ash-editor-pane-host:not([hidden])",
		)?.textContent,
		"stanza.editor.code",
	);
	assert.deepEqual(panes[0]?.visibilities, [
		EditorPaneVisibility.Hidden,
		EditorPaneVisibility.Visible,
	]);
	const titleControl = editor.domNode.querySelector(
		".ash-editor-title-control",
	);
	const tablist = titleControl?.querySelector(
		".ash-ordinary-editor-tabs-row .ash-action-bar",
	);
	const toolbar = titleControl?.querySelector(
		".ash-editor-title-actions > .ash-action-bar",
	);
	assert.equal(tablist?.getAttribute("role"), "tablist");
	assert.equal(toolbar?.getAttribute("role"), "toolbar");
	assert.equal(toolbar?.classList.contains("ash-toolbar"), true);
	assert.equal(
		titleControl?.querySelector(
			".ash-editor-tabs-control .ash-scrollable-element",
		)?.getAttribute("data-scroll-direction"),
		"horizontal",
	);
	assert.equal(
		titleControl?.querySelector(
			".ash-editor-tabs-control .ash-tab-list",
		)?.classList.contains("ash-tab-list-inset"),
		true,
	);
	assert.equal(
		tablist?.closest(".ash-multi-row-editor-tabs-control")?.nextElementSibling,
		toolbar?.parentElement,
	);
	const firstTab = tablist?.querySelector<HTMLElement>("[role='tab']");
	assert.equal(firstTab?.querySelector(".ash-icon-label-text")?.textContent, "main.ts");
	assert.equal(firstTab?.getAttribute("aria-selected"), "true");
	const firstPanelId = firstTab?.getAttribute("aria-controls");
	assert.ok(firstPanelId);
	assert.equal(
		editor.domNode.querySelector(`#${firstPanelId}`)?.getAttribute("role"),
		"tabpanel",
	);

	editor.layout({ width: 800, height: 600 });
	assert.deepEqual(panes[0]?.dimension, { width: 800, height: 543 });
	editor.focus();
	assert.equal(panes[0]?.focusCount, 1);

	const markdown = input("C:/project/paper.md");
	const codeBlockEditorWidgetPane = await editor.openEditor(markdown);
	assert.equal(editor.activePane, codeBlockEditorWidgetPane);
	assert.equal(editor.activeInput, markdown);
	assert.deepEqual(editor.activeGroup.inputs, [typescript, markdown]);
	assert.equal(
		editor.domNode.querySelector(
			".ash-editor-pane-host:not([hidden])",
		)?.textContent,
		"ash.editor.codeBlockEditorWidget",
	);
	assert.equal(panes[0]?.disposed, false);
	assert.deepEqual(panes[0]?.visibilities.slice(-1), [
		EditorPaneVisibility.Hidden,
	]);
	assert.deepEqual(panes[1]?.dimension, { width: 800, height: 543 });
	const tabs = editor.domNode.querySelectorAll<HTMLElement>("[role='tab']");
	assert.equal(tabs.length, 2);
	assert.deepEqual(
		[...tabs].map((tab) => tab.getAttribute("aria-selected")),
		["false", "true"],
	);

	tabs[0]?.click();
	assert.equal(editor.activeInput, typescript);
	assert.equal(editor.activePane, alphaPane);
	assert.equal(panes[0]?.focusCount, 2);
	assert.deepEqual(
		[...editor.domNode.querySelectorAll<HTMLElement>("[role='tab']")]
			.map((tab) => tab.getAttribute("aria-selected")),
		["true", "false"],
	);
	editor.domNode.querySelector<HTMLButtonElement>(
		".ash-editor-tabs-control .ash-tab-close-action button",
	)?.click();
	assert.equal(panes[0]?.disposed, true);
	assert.equal(editor.activeInput, markdown);
	assert.equal(editor.activePane, codeBlockEditorWidgetPane);
	assert.deepEqual(editor.activeGroup.inputs, [markdown]);
	assert.equal(
		editor.domNode.querySelectorAll("[role='tab']").length,
		1,
	);

	const content = h(dom.window.document, "div");
	content.textContent = "Welcome";
	await editor.setContent(content);
	assert.equal(editor.activePane, undefined);
	assert.equal(editor.activeInput, undefined);
	assert.equal(panes[1]?.disposed, true);
	assert.equal(editor.domNode.textContent, "Welcome");

	editor.dispose();
	dom.window.close();
});

test("EditorPart replaces preview tabs and preserves pinned tabs", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	registry.registerEditorPane(descriptor(
		"stanza.editor.code",
		".ts",
		() => trackPane(panes, "stanza.editor.code"),
	));
	const editor = createEditorPart(dom.window.document.body, { registry });
	dom.window.document.body.append(editor.domNode);
	const first = input("C:/project/first.ts");
	const second = input("C:/project/second.ts");
	const third = input("C:/project/third.ts");

	await editor.openEditor(first, { pinned: false });
	assert.deepEqual(editor.activeGroup.inputs, [first]);
	assert.equal(editor.domNode.querySelectorAll(".ash-tab.preview").length, 1);

	await editor.openEditor(second, { pinned: false });
	assert.deepEqual(editor.activeGroup.inputs, [second]);
	assert.equal(panes[0]?.disposed, true);
	assert.equal(editor.domNode.querySelector(".ash-tab.preview .ash-icon-label-text")?.textContent, "second.ts");

	await editor.openEditor(second, { pinned: true });
	assert.deepEqual(editor.activeGroup.inputs, [second]);
	assert.equal(editor.domNode.querySelector(".ash-tab.preview"), null);

	await editor.openEditor(third, { pinned: false });
	assert.deepEqual(editor.activeGroup.inputs, [second, third]);
	assert.equal(editor.domNode.querySelectorAll(".ash-tab.preview").length, 1);
	assert.equal(editor.domNode.querySelector(".ash-tab.preview .ash-icon-label-text")?.textContent, "third.ts");

	editor.dispose();
	dom.window.close();
});

test("EditorPart requires an explicit dirty-close decision", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const workingCopy = new TestWorkingCopy(URI.file("C:/project/dirty.ts"));
	workingCopy.markDirty();
	registry.registerEditorPane(descriptor(
		"stanza.editor.code",
		".ts",
		() => new TestEditorPane("stanza.editor.code", workingCopy),
	));
	const fileDialogs = new TestFileDialogService(ConfirmResult.CANCEL, ConfirmResult.DONT_SAVE);
	const editor = createEditorPart(dom.window.document.body, { registry, fileDialogService: fileDialogs });
	const resourceInput = input("C:/project/dirty.ts");
	await editor.openEditor(resourceInput);

	assert.equal(await editor.closeEditor(resourceInput), false);
	assert.equal(editor.activeInput, resourceInput);
	assert.equal(workingCopy.isDirty, true);
	assert.equal(await editor.closeEditor(resourceInput), true);
	assert.equal(editor.activeInput, undefined);
	assert.equal(workingCopy.revertCount, 1);
	assert.deepEqual(fileDialogs.prompts, [['dirty.ts'], ['dirty.ts']]);

	editor.dispose();
	dom.window.close();
});

test("EditorPart saves before closing and pins a dirty preview", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const copies = new Map<string, TestWorkingCopy>();
	registry.registerEditorPane(descriptor(
		"stanza.editor.code",
		".ts",
		() => {
			const workingCopy = new TestWorkingCopy(URI.file("C:\\project\\current.ts"));
			copies.set("current", workingCopy);
			return new TestEditorPane("stanza.editor.code", workingCopy);
		},
	));
	const fileDialogs = new TestFileDialogService(ConfirmResult.SAVE);
	const editor = createEditorPart(dom.window.document.body, { registry, fileDialogService: fileDialogs });
	const current = input("C:\\project\\current.ts");
	const next = input("C:\\project\\next.ts");
	await editor.openEditor(current, { pinned: false });
	const currentWorkingCopy = copies.get("current")!;
	currentWorkingCopy.markDirty();
	await editor.openEditor(next, { pinned: false });

	assert.deepEqual(editor.activeGroup.inputs, [current, next]);
	assert.equal(editor.activeGroup.isPreview(current), false);
	editor.activateEditor(current);
	assert.equal(await editor.closeEditor(current), true);
	assert.equal(currentWorkingCopy.saveCount, 1);
	assert.equal(currentWorkingCopy.isDirty, false);

	editor.dispose();
	dom.window.close();
});

test('EditorPart pins an already dirty working copy before opening another preview', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const registry = new EditorPaneRegistry();
		let created = 0;
		using registration = registry.registerEditorPane(descriptor('stanza.editor.code', '.ts', () => {
			const workingCopy = new TestWorkingCopy(URI.file('C:\\project\\current.ts'));
			if (created++ === 0) workingCopy.markDirty();
			return new TestEditorPane('stanza.editor.code', workingCopy);
		}));
		using editor = createEditorPart(dom.window.document.body, { registry });
		const dirty = input('C:\\project\\dirty.ts');
		const clean = input('C:\\project\\clean.ts');
		await editor.openEditor(dirty, { pinned: false });
		await editor.openEditor(clean, { pinned: false });
		assert.deepEqual(editor.activeGroup.editors.map(entry => ({ input: entry.input, preview: entry.isPreview, dirty: entry.isDirty })), [
			{ input: dirty, preview: false, dirty: true },
			{ input: clean, preview: true, dirty: false },
		]);
	} finally {
		dom.window.close();
	}
});

test("EditorPart opens beside the active group without stealing caller focus", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => trackPane(panes, "stanza.editor.code")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	dom.window.document.body.append(editor.domNode);
	const sourceInput = input("C:\\project\\source.ts");
	const previewInput = input("C:\\project\\preview.ts");
	const pinnedInput = input("C:\\project\\pinned.ts");
	await editor.openEditor(sourceInput);
	const sourceGroup = editor.activeGroup;
	using service = new BrowserEditorService(editor);
	let groupChanges = 0;
	let activeEditorChanges = 0;
	let visibleEditorChanges = 0;
	using groupListener = service.onDidChangeGroups(() => groupChanges += 1);
	using activeEditorListener = service.onDidActiveEditorChange(() => activeEditorChanges += 1);
	using visibleEditorListener = service.onDidVisibleEditorsChange(() => visibleEditorChanges += 1);

	await service.openEditor(previewInput, { pinned: false, preserveFocus: true }, "sideGroup");
	const previewPane = editor.groups[1]?.activePane as TestEditorPane;
	assert.equal(editor.groups.length, 2);
	assert.equal(service.count, 2);
	assert.equal(editor.activeGroup, sourceGroup);
	assert.deepEqual(editor.groups[1]?.inputs, [previewInput]);
	assert.equal(previewPane.focusCount, 0);

	await service.openEditor(pinnedInput, { pinned: true, preserveFocus: false }, "sideGroup");
	const pinnedPane = editor.groups[1]?.activePane as TestEditorPane;
	assert.equal(editor.groups.length, 2);
	assert.equal(editor.activeGroup, editor.groups[1]);
	assert.equal(service.activeGroup.id, editor.groups[1]?.id);
	assert.deepEqual(editor.groups[1]?.inputs, [previewInput, pinnedInput]);
	assert.equal(pinnedPane.focusCount, 1);
	assert.ok(groupChanges > 0);
	assert.ok(activeEditorChanges > 0);
	assert.ok(visibleEditorChanges > 0);

	editor.dispose();
	dom.window.close();
});

test("EditorPart saves and restores groups, tabs, previews, active state, and pane ownership", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => trackPane(panes, "stanza.editor.code")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	dom.window.document.body.append(editor.domNode);
	editor.layout({ width: 900, height: 600 });
	const first = input("C:\\project\\first.ts");
	const second = input("C:\\project\\second.ts");
	const third = input("C:\\project\\third.ts");

	await editor.openEditor(first, { pinned: true });
	await editor.openEditor(second, { pinned: false });
	await editor.splitActiveGroupHorizontal();
	await editor.openEditor(third, { pinned: true });
	editor.groups[0]!.activateEditor(first);
	editor.groups[1]!.activateEditor(third);
	const saved = editor.saveWorkingSet("main");
	const originalPanes = [...panes];

	await editor.applyWorkingSet("empty", { preserveFocus: true });
	assert.equal(editor.groups.length, 1);
	assert.deepEqual(editor.groups[0]?.inputs, []);
	assert.equal(editor.domNode.querySelectorAll(".ash-editor-pane-host").length, 0);
	assert.equal(originalPanes.every(pane => pane.disposed), true);

	await editor.applyWorkingSet(saved, { preserveFocus: true });
	assert.deepEqual(
		editor.groups.map(group => group.inputs.map(candidate => candidate.resource.fsPath)),
		[[first.resource.fsPath, second.resource.fsPath], [second.resource.fsPath, third.resource.fsPath]],
	);
	assert.equal(editor.groups[0]?.activeInput?.resource.fsPath, first.resource.fsPath);
	assert.equal(editor.groups[0]?.isPreview(editor.groups[0]!.inputs[1]!), true);
	assert.equal(editor.groups[1]?.activeInput?.resource.fsPath, third.resource.fsPath);
	assert.equal(editor.activeGroup, editor.groups[1]);
	assert.equal(editor.domNode.querySelectorAll(".ash-editor-pane-host").length, 4);

	editor.dispose();
	assert.equal(editor.domNode.querySelectorAll(".ash-editor-pane-host").length, 0);
	dom.window.close();
});

test('editor commands share group state for keep open, selected pins and close others', async () => {
	const prototype = browserEnvironment.window.HTMLElement.prototype;
	const scrollTo = Object.getOwnPropertyDescriptor(prototype, 'scrollTo');
	Object.defineProperty(prototype, 'scrollTo', { configurable: true, value: () => undefined });
	using scrollCleanup = toDisposable(() => {
		if (scrollTo) Object.defineProperty(prototype, 'scrollTo', scrollTo);
		else Reflect.deleteProperty(prototype, 'scrollTo');
	});
	const container = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(container);
	using cleanup = toDisposable(() => container.remove());
	using services = createTestEditorServices();
	const contextKeys = services.get(IContextKeyService);
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor('stanza.editor.code', '.ts', () => new TestEditorPane('stanza.editor.code')));
	using editor = services.createInstance(EditorPart, container, { registry, contextKeyService: contextKeys });
	using groups = new BrowserEditorService(editor);
	services.registerInstance(IEditorPart, editor);
	services.registerInstance(IEditorGroupsService, groups);
	using commands = new CommandService(services);
	using bindings = createTestWorkbenchContextKeysHandler(contextKeys, { editorService: groups, editorGroupsService: groups });
	const { CLOSE_EDITOR_COMMAND_ID, KEEP_EDITOR_COMMAND_ID, PIN_EDITOR_COMMAND_ID, UNPIN_EDITOR_COMMAND_ID, CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID } = await import('../../editorCommands.js');
	const menus = new MenuService(commands, contextKeys);
	using editorBindings = new EditorContextKeyController(contextKeys, editor, registry, undefined);
	const first = input('C:/project/first.ts');
	const second = input('C:/project/second.ts');
	const third = input('C:/project/third.ts');
	await editor.openEditor(first, { pinned: false });
	const group = groups.activeGroup;
	assert.equal(groups.getGroup(group.id), editor.activeGroup);
	await commands.executeCommand(KEEP_EDITOR_COMMAND_ID);
	assert.deepEqual({ preview: group.isPreview(first), sticky: group.isSticky(first) }, { preview: false, sticky: false });
	await editor.openEditor(second);
	await editor.openEditor(third);
	const label = (name: string) => container.querySelector<HTMLButtonElement>(`.ash-tab-label[aria-label="${name}"]`)!;
	label('first.ts').focus();
	// Keyboard commands follow the focused inactive tab, rather than the visible editor.
	await commands.executeCommand(PIN_EDITOR_COMMAND_ID);
	await commands.executeCommand(PIN_EDITOR_COMMAND_ID);
	assert.deepEqual({ sticky: group.isSticky(first), active: group.activeInput, focused: browserEnvironment.window.document.activeElement }, { sticky: true, active: third, focused: label('first.ts') });
	await commands.executeCommand(UNPIN_EDITOR_COMMAND_ID);
	assert.equal(group.isSticky(first), false);
	label('first.ts').dispatchEvent(new browserEnvironment.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
	await commands.executeCommand(PIN_EDITOR_COMMAND_ID, { groupId: group.id, editorIndex: 0 });
	assert.deepEqual(group.editors.map(state => state.isSticky), [true, true, false]);
	await commands.executeCommand(CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, { groupId: group.id, editorIndex: 2 });
	assert.deepEqual(group.inputs, [first, third, second]);
	await commands.executeCommand(UNPIN_EDITOR_COMMAND_ID, { groupId: group.id, editorIndex: 0 });
	await commands.executeCommand(CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, { groupId: group.id, editorIndex: 2 });
	assert.deepEqual(group.inputs, [second]);
	const pin = menus.getMenuActions(MenuId.EditorTitleContext).flatMap(([, actions]) => actions).find(action => action.id === PIN_EDITOR_COMMAND_ID)!;
	await pin.run();
	assert.equal(group.isSticky(second), true);
	await editor.openEditor(third, {}, 'modalGroup');
	assert.equal(editor.isModalEditorVisible, true);
	await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
	assert.deepEqual({ modal: editor.isModalEditorVisible, inputs: group.inputs }, { modal: false, inputs: [second] });
});

test('double-clicking a preview keeps the tab without making it sticky', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const registry = new EditorPaneRegistry();
		registry.registerEditorPane(descriptor('stanza.editor.code', '.ts', () => new TestEditorPane('stanza.editor.code')));
		using editor = createEditorPart(dom.window.document.body, { registry });
		const current = input('C:/project/current.ts');
		const next = input('C:/project/next.ts');
		await editor.openEditor(current, { pinned: false });
		const group = editor.activeGroup;
		const changes: string[] = [];
		using listener = group.onDidChangeEditors(event => changes.push(event.kind));
		const label = group.domNode.querySelector<HTMLButtonElement>('.ash-tab-label')!;
		const tabId = label.id;
		label.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
		const activeLabel = dom.window.document.getElementById(tabId)!;
		activeLabel.focus();
		assert.equal(activeLabel, label);
		activeLabel.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
		assert.deepEqual({ preview: group.isPreview(current), sticky: group.isSticky(current), focused: dom.window.document.activeElement?.id }, { preview: false, sticky: false, focused: tabId });
		assert.deepEqual(changes, ['editorStateChanged']);
		group.pinEditor();
		assert.deepEqual(changes, ['editorStateChanged']);
		await editor.openEditor(next, { pinned: false });
		assert.deepEqual(group.inputs, [current, next]);
		const saved = editor.saveWorkingSet('kept-preview');
		await editor.applyWorkingSet(saved, { preserveFocus: true });
		assert.deepEqual(editor.activeGroup.editors.map(state => ({ preview: state.isPreview, sticky: state.isSticky })), [{ preview: false, sticky: false }, { preview: true, sticky: false }]);
	} finally {
		dom.window.close();
	}
});

test("Editor tabs keep sticky editors in their own row across working-set restore", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => new TestEditorPane("stanza.editor.code")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const first = input("C:\\project\\first.ts");
	const second = input("C:\\project\\second.ts");
	await editor.openEditor(first);
	await editor.openEditor(second);

	const stick = editor.domNode.querySelector<HTMLButtonElement>(
		'.ash-ordinary-editor-tabs-row .ash-tab:first-child .ash-tab-label',
	);
	assert.ok(stick);
	editor.activeGroup.stickEditor(first);
	assert.equal(editor.activeGroup.isSticky(first), true);
	assert.equal(editor.activeGroup.isPreview(first), false);
	assert.equal(editor.domNode.querySelectorAll(".ash-sticky-editor-tabs-row .ash-tab").length, 1);
	assert.equal(editor.domNode.querySelectorAll(".ash-ordinary-editor-tabs-row .ash-tab").length, 1);
	assert.equal(editor.domNode.querySelector(".ash-editor-title-control")?.getAttribute("style"), "--ash-editor-tab-rows: 2;");

	const saved = editor.saveWorkingSet("sticky");
	await editor.applyWorkingSet(saved, { preserveFocus: true });
	assert.equal(editor.activeGroup.isSticky(first), true);
	assert.equal(editor.domNode.querySelectorAll(".ash-sticky-editor-tabs-row .ash-tab").length, 1);

	const unstick = editor.domNode.querySelector<HTMLButtonElement>(
		'.ash-sticky-editor-tabs-row .ash-tab .ash-tab-label',
	);
	assert.ok(unstick);
	const unpin = editor.domNode.querySelector<HTMLButtonElement>('.ash-sticky-editor-tabs-row .ash-tab-primary-action button')!;
	assert.equal(unpin.getAttribute('aria-label'), 'Unpin Editor');
	assert.equal(editor.domNode.querySelector('.ash-sticky-editor-tabs-row .ash-tab-close-action'), null);
	const activeBeforeUnpin = editor.activeGroup.activeInput;
	unpin.focus();
	unpin.click();
	assert.equal(editor.activeGroup.isSticky(first), false);
	assert.deepEqual(editor.activeGroup.inputs, [first, second]);
	assert.equal(editor.activeGroup.activeInput, activeBeforeUnpin);
	assert.equal(dom.window.document.activeElement?.id, unstick.id);
	assert.equal(editor.domNode.querySelectorAll(".ash-sticky-editor-tabs-row .ash-tab").length, 0);

	editor.dispose();
	dom.window.close();
});

test("EditorPart publishes stable editor identities and working-copy state changes", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const workingCopies: TestWorkingCopy[] = [];
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => {
		const workingCopy = new TestWorkingCopy(URI.file(`C:\\project\\state-${workingCopies.length}.ts`));
		workingCopies.push(workingCopy);
		return new TestEditorPane("stanza.editor.code", workingCopy);
	}));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const events: string[] = [];
	editor.onDidChangeEditors(event => {
		events.push(event.kind === "groupChanged" ? event.event.kind : event.kind);
	});
	const first = input("C:\\project\\first.ts");
	const second = input("C:\\project\\second.ts");
	await editor.openEditor(first);
	await editor.openEditor(second);
	const beforeDirty = editor.getEditorState();
	const identities = beforeDirty.groups[0]!.editors.map(candidate => candidate.instanceId);

	assert.equal(new Set(identities).size, 2);
	assert.equal(beforeDirty.activeEditor?.instanceId, identities[1]);
	workingCopies[0]!.markDirty();
	assert.equal(editor.getEditorState().groups[0]!.editors[0]!.isDirty, true);
	assert.deepEqual(events.slice(0, 4), [
		"editorOpened",
		"activeEditorChanged",
		"editorOpened",
		"activeEditorChanged",
	]);
	assert.equal(events.at(-1), "editorStateChanged");

	editor.dispose();
	dom.window.close();
});

test("EditorPart tracks MRU editors, reopens closed inputs, and reopens with another pane", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("test.editor.default", ".ts", () => new TestEditorPane("test.editor.default")));
	registry.registerEditorPane(descriptor("test.editor.alternate", ".ts", () => new TestEditorPane("test.editor.alternate")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const first = input("C:\\project\\first.ts");
	const second = input("C:\\project\\second.ts");
	await editor.openEditor(first);
	await editor.openEditor(second);

	assert.deepEqual(editor.editorsMru.map(candidate => candidate.input), [second, first]);
	editor.activateEditorMru(1);
	assert.equal(editor.activeInput, first);
	assert.deepEqual(editor.editorsMru.map(candidate => candidate.input), [first, second]);
	assert.equal(await editor.closeEditor(first), true);
	assert.equal(editor.recentlyClosedEditors[0]?.input, first);
	assert.equal(await editor.reopenClosedEditor(), true);
	assert.equal(editor.activeInput?.resource.fsPath, first.resource.fsPath);
	assert.equal(editor.recentlyClosedEditors.length, 0);
	const instanceId = editor.getEditorState().activeEditor?.instanceId;

	assert.deepEqual(editor.getEditorPaneChoices().map(candidate => candidate.id), ["test.editor.default", "test.editor.alternate"]);
	await editor.reopenActiveEditorWith("test.editor.alternate");
	assert.equal(editor.activePane?.id, "test.editor.alternate");
	assert.equal(editor.getEditorState().activeEditor?.instanceId, instanceId);

	editor.dispose();
	dom.window.close();
});

test('EditorPart does not reopen discarded untitled template content', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor('test.editor.default', '', () => new TestEditorPane('test.editor.default')));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const template: EditorInput = { resource: URI.parse('untitled:/Untitled-1'), label: 'Untitled-1', initialText: 'template body' };
	await editor.openEditor(template);
	assert.equal(await editor.closeEditor(template), true);
	assert.deepEqual({ recentlyClosed: editor.recentlyClosedEditors.length, reopened: await editor.reopenClosedEditor() }, { recentlyClosed: 0, reopened: false });
	editor.dispose();
	dom.window.close();
});

test('EditorPart refreshes the tab when an input changes its label and custom icon', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor('test.editor.default', '', () => new TestEditorPane('test.editor.default')));
	const editor = createEditorPart(dom.window.document.body, { registry });
	using labelChanges = new Emitter<void>();
	let label = 'Untitled-1';
	let icon = URI.parse('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>');
	const untitled: EditorInput = { resource: URI.parse('untitled:/Untitled-1'), get label() { return label; }, getIcon: () => icon, onDidChangeLabel: labelChanges.event };
	await editor.openEditor(untitled);
	assert.equal(editor.domNode.querySelector<HTMLImageElement>('.ash-icon-label-image')?.src, icon.toString());
	label = 'Scratch';
	icon = URI.parse('data:image/png;base64,aWNvbg==');
	labelChanges.fire();
	assert.equal(editor.domNode.querySelector('.ash-tab .ash-icon-label-text')?.textContent, 'Scratch');
	assert.equal(editor.domNode.querySelector<HTMLImageElement>('.ash-icon-label-image')?.src, icon.toString());
	const workingSet = JSON.parse(JSON.stringify(editor.saveWorkingSet('custom-icon')));
	await editor.applyWorkingSet('empty');
	await editor.applyWorkingSet(workingSet);
	assert.equal(editor.domNode.querySelector<HTMLImageElement>('.ash-icon-label-image')?.src, icon.toString());
	editor.dispose();
	dom.window.close();
});

test('editor input snapshots preserve semantic icon colors and reject malformed icons', () => {
	const registry = new EditorInputSerializerRegistry();
	const icon = { id: 'home', color: { id: 'editor.foreground' } };
	const input: EditorInput = { resource: URI.parse('ash-welcome:/welcome'), getIcon: () => icon };
	const snapshot = JSON.parse(JSON.stringify(registry.serialize(input)));
	assert.deepEqual(registry.deserialize(snapshot).getIcon?.(), icon);
	snapshot.value.icon = { id: 'home', color: 42 };
	assert.throws(() => registry.deserialize(snapshot), /icon color must be a string/);
});

test("EditorPart keeps MRU order across groups and removes closed editors", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("test.editor.default", ".ts", () => new TestEditorPane("test.editor.default")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const first = input("C:\\project\\first.ts");
	const second = input("C:\\project\\second.ts");

	await editor.openEditor(first);
	const firstEditor = editor.editorsMru[0]!;
	await editor.openEditor(second, {}, "sideGroup");
	assert.deepEqual(editor.editorsMru.map(candidate => candidate.input), [second, first]);

	editor.activateEditorIdentifier(firstEditor);
	assert.deepEqual(editor.editorsMru.map(candidate => candidate.input), [first, second]);
	await editor.closeEditor(first);
	assert.deepEqual(editor.editorsMru.map(candidate => candidate.input), [second]);

	editor.dispose();
	dom.window.close();
});

test("EditorPart persists JSON-safe pane view state in working sets", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestViewStateEditorPane[] = [];
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => {
		const pane = new TestViewStateEditorPane("stanza.editor.code");
		panes.push(pane);
		return pane;
	}));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const resourceInput = { ...input("C:\\project\\view-state.ts"), showBreadcrumbs: false };
	await editor.openEditor(resourceInput);
	panes[0]!.viewState = { cursorLine: 42, scrollTop: 320 };
	const saved = editor.saveWorkingSet("view-state");

	assert.deepEqual(saved.groups[0]!.editors[0]!.viewState, {
		typeId: "test.textView",
		value: { cursorLine: 42, scrollTop: 320 },
	});
	await editor.applyWorkingSet("empty", { preserveFocus: true });
	await editor.applyWorkingSet(saved, { preserveFocus: true });
	assert.deepEqual(panes[1]!.restoredViewState, { cursorLine: 42, scrollTop: 320 });
	assert.equal(editor.activeInput?.showBreadcrumbs, false);
	assert.equal(editor.domNode.querySelector<HTMLElement>('.ash-editor-breadcrumbs')?.hidden, true);

	editor.dispose();
	dom.window.close();
});

test("EditorPart registers and releases focusable breadcrumbs for its group", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => new TestEditorPane("stanza.editor.code")));
	const breadcrumbs = new BreadcrumbsService();
	const editor = createEditorPart(dom.window.document.body, {
		registry,
		breadcrumbsService: breadcrumbs,
		showBreadcrumbPicker: () => {},
	});
	const group = editor.activeGroup;
	const control = breadcrumbs.getWidget(group.id);
	assert.ok(control);
	assert.equal(control.focus(), false);
	await editor.openEditor(input("C:/project/folder/breadcrumb.ts"));
	assert.equal(control.focus(), true);
	assert.equal(dom.window.document.activeElement?.textContent, "breadcrumb.ts");
	await editor.closeAllEditors({ skipConfirmation: true });
	assert.equal(control.focus(), false);
	editor.dispose();
	assert.equal(breadcrumbs.getWidget(group.id), undefined);
	dom.window.close();
});

test("HistoryService navigates backward and forward through opened editors", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("ash.test.history", ".ts", () => new TestEditorPane("ash.test.history")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const contextKeys = new ContextKeyService();
	const history = new HistoryService(editor, contextKeys);
	const first = input("C:\\project\\first.ts");
	const second = input("C:\\project\\second.ts");
	const third = input("C:\\project\\third.ts");
	await editor.openEditor(first, { pinned: true });
	await editor.openEditor(second, { pinned: true });
	await editor.openEditor(third, { pinned: true });
	assert.equal(contextKeys.getValue('canNavigateBack'), true);
	assert.equal(contextKeys.getValue('canNavigateForward'), false);
	await history.goBack();
	assert.equal(editor.activeInput?.resource.toString(), second.resource.toString());
	await history.goBack();
	assert.equal(editor.activeInput?.resource.toString(), first.resource.toString());
	assert.equal(contextKeys.getValue('canNavigateBack'), false);
	assert.equal(contextKeys.getValue('canNavigateForward'), true);
	await history.goForward();
	assert.equal(editor.activeInput?.resource.toString(), second.resource.toString());
	await editor.openEditor(input("C:\\project\\new.ts"), { pinned: true });
	assert.equal(contextKeys.getValue('canNavigateForward'), false);
	history.dispose();
	contextKeys.dispose();
	editor.dispose();
	dom.window.close();
});

test('HistoryService restores cursor, edit, and navigation locations', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	let pane: TestSelectionPane | undefined;
	registry.registerEditorPane(descriptor('ash.test.selectionHistory', '.ts', () => pane = new TestSelectionPane('ash.test.selectionHistory')));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const contextKeys = new ContextKeyService();
	const history = new HistoryService(editor, contextKeys);
	await editor.openEditor(input('C:\\project\\locations.ts'), { pinned: true });
	assert.ok(pane);
	using services = new InstantiationService();
	services.registerInstance(IHistoryService, history);
	using commands = new CommandService(services);

	const activePane = pane;
	activePane.setPosition(20, EditorPaneSelectionChangeReason.USER);
	activePane.setPosition(40, EditorPaneSelectionChangeReason.USER);
	await history.goBack();
	assert.equal(activePane.getSelection()?.startLineNumber, 20);
	await history.goBack();
	assert.equal(activePane.getSelection()?.startLineNumber, 1);
	await history.goForward();
	assert.equal(activePane.getSelection()?.startLineNumber, 20);
	assert.equal(activePane.lastRestoreSource, TextEditorSelectionSource.PROGRAMMATIC);

	activePane.setPosition(35, EditorPaneSelectionChangeReason.EDIT);
	activePane.setPosition(50, EditorPaneSelectionChangeReason.EDIT);
	activePane.setPosition(70, EditorPaneSelectionChangeReason.USER);
	assert.equal(contextKeys.getValue('canNavigateBackInEditLocations'), true);
	await commands.executeCommand('workbench.action.navigateBackInEditLocations');
	assert.equal(activePane.getSelection()?.startLineNumber, 50);
	await history.goBack(GoFilter.EDITS);
	assert.equal(activePane.getSelection()?.startLineNumber, 35);
	await commands.executeCommand('workbench.action.navigateForwardInEditLocations');
	assert.equal(activePane.getSelection()?.startLineNumber, 50);
	await history.goBack(GoFilter.EDITS);
	activePane.setPosition(36, EditorPaneSelectionChangeReason.EDIT);
	assert.equal(contextKeys.getValue('canNavigateForwardInEditLocations'), false);

	activePane.setPosition(55, EditorPaneSelectionChangeReason.USER);
	activePane.setPosition(80, EditorPaneSelectionChangeReason.JUMP);
	assert.equal(contextKeys.getValue('canNavigateBackInNavigationLocations'), true);
	await commands.executeCommand('workbench.action.navigateBackInNavigationLocations');
	assert.equal(activePane.getSelection()?.startLineNumber, 55);
	await commands.executeCommand('workbench.action.navigateForwardInNavigationLocations');
	assert.equal(activePane.getSelection()?.startLineNumber, 80);
	const nextPane = await editor.openEditor(input('C:\\project\\jump-target.ts'), {
		pinned: true,
		selection: new Range(12, 3, 12, 3),
		selectionSource: TextEditorSelectionSource.JUMP,
	});
	assert.ok(nextPane instanceof TestSelectionPane);
	assert.equal(nextPane.getSelection()?.startLineNumber, 12);
	await history.goBack(GoFilter.NAVIGATION);
	assert.equal(editor.activePane, activePane);
	assert.equal(activePane.getSelection()?.startLineNumber, 80);
	await history.goForward(GoFilter.NAVIGATION);
	assert.equal(editor.activePane, nextPane);
	assert.equal(nextPane.getSelection()?.startLineNumber, 12);

	history.dispose();
	contextKeys.dispose();
	editor.dispose();
	dom.window.close();
});

test('tab split commands copy multiple inactive tabs beside their source group', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const registry = new EditorPaneRegistry();
		using registration = registry.registerEditorPane(descriptor('stanza.editor.code', '.ts', () => new TestEditorPane('stanza.editor.code')));
		using editor = createEditorPart(dom.window.document.body, { registry });
		using services = new InstantiationService();
		using editorService = new BrowserEditorService(editor);
		services.registerInstance(IEditorPart, editor);
		services.registerInstance(IEditorGroupsService, editorService);
		using commands = new CommandService(services);
		dom.window.document.body.append(editor.domNode);
		editor.layout({ width: 960, height: 640 });
		const first = input('/project/first.ts');
		const second = input('/project/second.ts');
		const active = input('/project/active.ts');
		await editor.openEditor(first);
		await editor.openEditor(second);
		await editor.openEditor(active);
		const source = editor.activeGroup;
		const tabs = source.domNode.querySelectorAll<HTMLElement>('[role="tab"]');
		tabs[0]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		tabs[1]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }));
		assert.deepEqual(source.selectedInputs, [first, second]);
		await commands.executeCommand('workbench.action.splitEditorLeft', { groupId: source.id, editorIndex: 0 });
		assert.deepEqual(editor.groups.map(group => group.inputs), [[first, second, active], [first, second]]);
		assert.equal(editor.activeGroup.activeInput, second);
		assert.equal(editor.activeGroup.isPreview(first), false);
		assert.equal(editor.activeGroup.isPreview(second), false);
		const sourceBounds = source.domNode.parentElement!.style.left;
		const copiedBounds = editor.activeGroup.domNode.parentElement!.style.left;
		assert.ok(parseFloat(copiedBounds) < parseFloat(sourceBounds));
	} finally {
		dom.window.close();
	}
});

test("EditorPart restores nested horizontal and vertical Grid layouts", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => new TestEditorPane("stanza.editor.code")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	editor.layout({ width: 960, height: 640 });
	await editor.openEditor(input("C:\\project\\left.ts"));
	await editor.splitActiveGroupHorizontal();
	await editor.openEditor(input("C:\\project\\top-right.ts"));
	await editor.splitActiveGroupVertical();
	await editor.openEditor(input("C:\\project\\bottom-right.ts"));
	assert.equal(editor.domNode.querySelectorAll(".ash-split-view-separator-border").length, 2);
	const saved = editor.saveWorkingSet("nested-grid");

	assert.equal(saved.layout?.type, "branch");
	assert.equal(saved.layout?.orientation, "horizontal");
	assert.equal(saved.layout?.type === "branch" && saved.layout.children[1]?.type, "branch");
	const rightBranch = saved.layout?.type === "branch" && saved.layout.children[1]?.type === "branch"
		? saved.layout.children[1]
		: undefined;
	assert.equal(rightBranch?.orientation, "vertical");
	const groupIds = saved.groups.map(group => group.id);

	await editor.applyWorkingSet("empty", { preserveFocus: true });
	await editor.applyWorkingSet(saved, { preserveFocus: true });
	assert.deepEqual(editor.groups.map(group => group.id), groupIds);
	assert.equal(editor.domNode.querySelectorAll(".ash-split-view-separator-border").length, 2);
	const restored = editor.saveWorkingSet("nested-grid-restored");
	assert.equal(restored.layout?.type, "branch");
	assert.equal(restored.layout?.orientation, "horizontal");
	assert.equal(restored.layout?.type === "branch" && restored.layout.children[1]?.type === "branch" && restored.layout.children[1].orientation, "vertical");

	editor.dispose();
	dom.window.close();
});

test("EditorPart validates Grid layouts before closing current editors", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => new TestEditorPane("stanza.editor.code")));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const current = input("C:\\project\\safe.ts");
	await editor.openEditor(current);
	const saved = editor.saveWorkingSet("safe");
	const invalid = {
		...saved,
		layout: saved.layout?.type === "leaf"
			? { ...saved.layout, data: { groupId: "unknown-group" } }
			: saved.layout?.type === "branch"
				? { ...saved.layout, children: [{ ...saved.layout.children[0]!, data: { groupId: "unknown-group" } }] }
				: undefined,
	} as typeof saved;

	await assert.rejects(editor.applyWorkingSet(invalid), /Editor Grid/);
	assert.equal(editor.activeInput, current);

	editor.dispose();
	dom.window.close();
});

test("Editor title toolbar splits the active group and owns More Actions", async () => {
	const [
		{ MenuService },
		{ ContextKeyService },
		{ InstantiationService },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../../platform/actions/common/menuService.js"),
		import("../../../../../../platform/contextkey/browser/contextKeyService.js"),
		import('../../../../../../platform/instantiation/common/instantiationService.js'),
		import("../../../../../../workbench/services/commands/common/commandService.js"),
	]);
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	registry.registerEditorPane(descriptor(
		"stanza.editor.code",
		".ts",
		() => trackPane(panes, "stanza.editor.code"),
	));
	const services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	const menus = new MenuService(commands, contextKeys);
	const editor = createEditorPart(dom.window.document.body, {
		registry,
		contextKeyService: contextKeys,
		titleActions: {
			menuService: menus,
			contextMenuProvider: {
				showContextMenu() {},
			},
		},
	});
	services.registerInstance(IEditorPart, editor);
	using editorService = new BrowserEditorService(editor);
	services.registerInstance(IEditorGroupsService, editorService);
	dom.window.document.body.append(editor.domNode);
	const activeInput = input("C:\\project\\main.ts");
	await editor.openEditor(activeInput);
	assert.equal(contextKeys.getContext(editor.activeGroup.domNode).getValue(ActiveEditorContext.key), "stanza.editor.code");
	editor.layout({ width: 800, height: 600 });

	const toolbar = editor.domNode.querySelector(
		".ash-editor-title-actions > .ash-toolbar",
	);
	assert.deepEqual(
		[...toolbar?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []]
			.map((item) => item.dataset.actionId),
		[
			SplitEditorHorizontalCommandId,
			"ash.toolbar.moreActions",
		],
	);
	assert.deepEqual(
		[...toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? []]
			.map((button) => button.title),
		["Split Editor Horizontal", "More Actions"],
	);

	toolbar?.querySelector<HTMLButtonElement>(
		`[data-action-id="${SplitEditorHorizontalCommandId}"] button`,
	)?.click();
	await nextTask();

	assert.equal(editor.groups.length, 2);
	assert.equal(editor.activeGroup, editor.groups[1]);
	assert.deepEqual(
		editor.groups.map((group) => group.inputs),
		[[activeInput], [activeInput]],
	);
	assert.equal(
		editor.domNode.querySelectorAll(
			":scope .ash-split-view > .ash-split-view-pane",
		).length,
		2,
	);
	assert.equal(
		editor.domNode.querySelectorAll(
			":scope .ash-split-view > .ash-sash",
		).length,
		1,
	);
	assert.deepEqual(
		panes.map((pane) => pane.dimension),
		[
			{ width: 400, height: 543 },
			{ width: 400, height: 543 },
		],
	);

	editor.dispose();
	dom.window.close();
});

test("EditorPart preserves working tabs and opens a failure in its own tab", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const panes: TestEditorPane[] = [];
	registry.registerEditorPane(descriptor(
		"ash.editor.working",
		".ok",
		() => trackPane(panes, "ash.editor.working"),
	));
	registry.registerEditorPane(descriptor(
		"ash.editor.failing",
		".bad",
		() => {
			const pane = trackPane(panes, "ash.editor.failing");
			pane.inputError = new Error("Unable to load input");
			return pane;
		},
	));
	const editor = createEditorPart(dom.window.document.body, { registry });
	dom.window.document.body.append(editor.domNode);
	const workingInput = input("C:\\project\\document.ok");
	const workingPane = await editor.openEditor(workingInput);

	const failedInput = input("C:\\project\\document.bad");
	await editor.openEditor(failedInput);
	assert.equal(editor.activePane?.id, "workbench.editor.openError");
	assert.equal(editor.activeInput, failedInput);
	assert.deepEqual(editor.activeGroup.inputs, [workingInput, failedInput]);
	editor.activateEditor(workingInput);
	assert.equal(editor.activePane, workingPane);
	assert.equal(panes[1]?.disposed, true);

	editor.dispose();
	dom.window.close();
});

test('editor context keys follow preview, readonly, dirty, and close transitions', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	dom.window.HTMLElement.prototype.scrollTo = () => undefined;
	const registry = new EditorPaneRegistry();
	const resource = URI.file('C:\\project\\readonly.ts');
	let workingCopy: TestWorkingCopy | undefined;
	registry.registerEditorPane(descriptor(
		'stanza.editor.code',
		'.ts',
		() => {
			workingCopy = new TestWorkingCopy(resource);
			return new TestEditorPane('stanza.editor.code', workingCopy);
		},
	));
	using contextKeys = new ContextKeyService();
	const contextChanges: string[][] = [];
	using contextListener = contextKeys.onDidChangeContext(event => contextChanges.push([...event.keys]));
	const editor = createEditorPart(dom.window.document.body, {
		contextKeyService: contextKeys,
		fileDialogService: new TestFileDialogService(ConfirmResult.DONT_SAVE),
		registry,
	});
	const groupProjectionChanges = contextChanges.filter(keys => keys.includes('resourceSet'));
	assert.equal(groupProjectionChanges.length, 1);
	assert.equal(groupProjectionChanges[0]?.includes('activeEditor'), true);
	contextChanges.length = 0;
	using editorContexts = new EditorContextKeyController(contextKeys, editor, registry, undefined);
	using editorService = new BrowserEditorService(editor);
	using workbenchContexts = createTestWorkbenchContextKeysHandler(contextKeys, {
		editorGroupsService: editorService,
		editorService,
	});
	const editorProjectionChanges = contextChanges.filter(keys => keys.includes('resourceSet'));
	assert.equal(editorProjectionChanges.length, 1);
	assert.equal(editorProjectionChanges[0]?.includes('activeEditor'), true);
	assert.equal(contextKeys.getValue('activeEditorGroupIndex'), 1);
	const activeInput: EditorInput = { resource, languageId: 'typescript', readOnly: true };
	await editor.openEditor(activeInput, { pinned: false });

	assert.deepEqual({
		canRevert: contextKeys.getValue('activeEditorCanRevert'),
		dirty: contextKeys.getValue('activeEditorIsDirty'),
		pinned: contextKeys.getValue('activeEditorIsNotPreview'),
		readonly: contextKeys.getValue('activeEditorIsReadonly'),
	}, {
		canRevert: true,
		dirty: false,
		pinned: false,
		readonly: true,
	});
	workingCopy?.markDirty();
	assert.equal(contextKeys.getValue('activeEditorIsDirty'), true);
	const groupContext = contextKeys.getContext(editor.activeGroup.domNode);
	assert.deepEqual({
		dirty: groupContext.getValue('activeEditorIsDirty'),
		resource: groupContext.getValue('resource'),
		resourceSet: groupContext.getValue('resourceSet'),
	}, {
		dirty: true,
		resource: resource.toString(),
		resourceSet: true,
	});

	await editor.closeEditor(activeInput);
	assert.deepEqual({
		activeEditor: contextKeys.getValue('activeEditor'),
		dirty: contextKeys.getValue('activeEditorIsDirty'),
		editorIsOpen: contextKeys.getValue('editorIsOpen'),
		resource: contextKeys.getValue('resource'),
		resourceSet: contextKeys.getValue('resourceSet'),
	}, {
		activeEditor: '',
		dirty: false,
		editorIsOpen: false,
		resource: undefined,
		resourceSet: false,
	});

	await editor.openEditor(activeInput, {}, 'modalGroup');
	assert.deepEqual({
		activeEditor: contextKeys.getValue('activeEditor'),
		activeEditorGroupEmpty: contextKeys.getValue('activeEditorGroupEmpty'),
		editorPartModalVisible: contextKeys.getValue('editorPartModalVisible'),
		groupEditorsCount: contextKeys.getValue('groupEditorsCount'),
		resourceSet: contextKeys.getValue('resourceSet'),
	}, {
		activeEditor: 'stanza.editor.code',
		activeEditorGroupEmpty: false,
		editorPartModalVisible: true,
		groupEditorsCount: 0,
		resourceSet: true,
	});
	await editor.closeEditor(activeInput);
	assert.equal(contextKeys.getValue('editorPartModalVisible'), false);

	editor.dispose();
	dom.window.close();
});

test("EditorPart shows a retryable placeholder when an editor cannot open", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	let attempts = 0;
	registry.registerEditorPane(descriptor(
		"ash.editor.retryable",
		".retry",
		() => {
			const pane = new TestEditorPane("ash.editor.retryable");
			attempts += 1;
			if (attempts === 1) pane.inputError = new Error("Temporary decoder failure");
			return pane;
		},
	));
	const editor = createEditorPart(dom.window.document.body, { registry });
	const retryable = input("C:/project/document.retry");

	await editor.openEditor(retryable);
	assert.equal(editor.activeInput, retryable);
	assert.equal(editor.activePane?.id, "workbench.editor.openError");
	assert.match(editor.domNode.textContent ?? "", /Unable to open document\.retry/);
	assert.match(editor.domNode.textContent ?? "", /Temporary decoder failure/);
	editor.domNode.querySelector<HTMLButtonElement>(".ash-editor-open-error-actions button")?.click();
	await nextTask();

	assert.equal(attempts, 2);
	assert.equal(editor.activePane?.id, "ash.editor.retryable");
	assert.equal(editor.domNode.querySelector(".ash-editor-open-error"), null);

	editor.dispose();
	dom.window.close();
});

test("Editor open error offers a registered Binary Editor for unsafe text content", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor("ash.editor.text", ".bin", () => {
		const pane = new TestEditorPane("ash.editor.text");
		pane.inputError = new TextFileBinaryError(URI.file("C:\\project\\unsafe.bin"));
		return pane;
	}));
	registry.registerEditorPane({
		id: "ash.editor.binary",
		name: "Binary Editor",
		canOpen: () => EditorPaneMatch.Optional,
		create: () => new TestEditorPane("ash.editor.binary"),
	});
	const editor = createEditorPart(dom.window.document.body, { registry });
	await editor.openEditor(input("C:\\project\\unsafe.bin"));
	const button = [...editor.domNode.querySelectorAll<HTMLButtonElement>(".ash-editor-open-error-actions button")]
		.find(candidate => candidate.textContent === "Open as Binary");
	assert.ok(button);
	button.click();
	await nextTask();
	assert.equal(editor.activePane?.id, "ash.editor.binary");

	editor.dispose();
	dom.window.close();
});

test("EditorPart rejects an open superseded by ordinary content", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const registry = new EditorPaneRegistry();
	const pending = deferred<void>();
	let slowPane: TestEditorPane | undefined;
	registry.registerEditorPane(descriptor(
		"ash.editor.slow",
		".slow",
		() => {
			const pane = new TestEditorPane("ash.editor.slow");
			pane.inputPromise = pending.promise;
			slowPane = pane;
			return pane;
		},
	));
	const editor = createEditorPart(dom.window.document.body, { registry });
	dom.window.document.body.append(editor.domNode);
	const opening = editor.openEditor(input("C:\\project\\document.slow"));
	const content = h(dom.window.document, "div");
	content.textContent = "Replacement";
	await editor.setContent(content);
	assert.equal(slowPane?.inputSignal?.aborted, true);
	pending.resolve(undefined);

	await assert.rejects(
		opening,
		EditorOpenSupersededError,
	);
	assert.equal(editor.activePane, undefined);
	assert.equal(editor.domNode.textContent, "Replacement");

	editor.dispose();
	dom.window.close();
});

test("EditorParts moves an editor to an auxiliary window without changing its instance identity", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: 'http://localhost' });
	const registry = new EditorPaneRegistry();
	const workingCopy = new TestWorkingCopy(URI.file("C:\\project\\detached.ts"));
	registry.registerEditorPane(descriptor("stanza.editor.code", ".ts", () => new TestEditorPane("stanza.editor.code", workingCopy)));
	const main = createEditorPart(dom.window.document.body, { registry });
	const windows = new TestAuxiliaryWindowService();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, applicationId: 'editor-parts-test', workspaceId: 'workspace', flushInterval: 0 });
	const editorParts = new EditorParts(main, windows, container => createAuxiliaryPart(container, registry), {
		onDidChangeScreenReaderOptimized: Event.None,
		isScreenReaderOptimized: () => false,
	} as unknown as IAccessibilityService, storage);
	using contextKeys = new ContextKeyService();
	using editorContexts = new EditorContextKeyController(contextKeys, editorParts, registry, undefined);
	const resourceInput = input("C:\\project\\detached.ts");
	await editorParts.openEditor(resourceInput);
	const instanceId = editorParts.getEditorState().activeEditor?.instanceId;
	assert.equal(contextKeys.getValue('resource'), resourceInput.resource.toString());
	workingCopy.markDirty();

	const auxiliary = await editorParts.moveActiveEditorToNewWindow();
	assert.ok(auxiliary);
	assert.equal(editorParts.parts.length, 2);
	assert.equal(main.groups[0]?.inputs.length, 0);
	assert.equal(auxiliary.activeInput?.resource.fsPath, resourceInput.resource.fsPath);
	assert.equal(auxiliary.getEditorState().activeEditor?.instanceId, instanceId);
	assert.equal(contextKeys.getValue('activeEditor'), 'stanza.editor.code');
	assert.equal(contextKeys.getValue('resource'), resourceInput.resource.toString());
	assert.ok(windows.lastWindow?.container.querySelector(".ash-workbench-statusbar"));
	assert.match(windows.lastWindow?.requestBeforeUnload() ?? "", /unsaved changes/i);
	assert.equal(await editorParts.closeAuxiliaryEditorPart(auxiliary), false);

	await workingCopy.save();
	const secondInput = input("C:\\project\\second.ts");
	await auxiliary.openEditor(secondInput);
	auxiliary.activateEditor(resourceInput);
	windows.lastWindow?.dispose();
	await nextTask();
	assert.equal(editorParts.parts.length, 1);
	assert.equal(editorParts.activePart, main);
	assert.equal(main.groups[0]?.inputs.length, 2);
	assert.equal(main.getEditorState().activeEditor?.instanceId, instanceId);
	assert.equal(main.activeInput?.resource.fsPath, resourceInput.resource.fsPath);
	const detachedAgain = await editorParts.moveActiveEditorToNewWindow();
	assert.ok(detachedAgain);
	assert.equal(await editorParts.closeAuxiliaryEditorPart(detachedAgain), true);
	assert.equal(editorParts.parts.length, 1);

	editorParts.dispose();
	windows.dispose();
	main.dispose();
	workingCopy.dispose();
	dom.window.close();
});

test('tab split commands route to an inactive auxiliary window by source group', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
	try {
		const registry = new EditorPaneRegistry();
		using registration = registry.registerEditorPane(descriptor('stanza.editor.code', '.ts', () => new TestEditorPane('stanza.editor.code')));
		using main = createEditorPart(dom.window.document.body, { registry });
		using windows = new TestAuxiliaryWindowService();
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, applicationId: 'tab-split-test', workspaceId: 'workspace', flushInterval: 0 });
		using parts = new EditorParts(main, windows, container => createAuxiliaryPart(container, registry), {
			onDidChangeScreenReaderOptimized: Event.None,
			isScreenReaderOptimized: () => false,
		} as unknown as IAccessibilityService, storage);
		const auxiliary = await parts.createAuxiliaryEditorPart();
		const clicked = input('/project/clicked.ts');
		const active = input('/project/active.ts');
		await auxiliary.openEditor(clicked);
		await main.openEditor(active);
		main.domNode.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
		assert.equal(parts.activePart, main);
		using services = new InstantiationService();
		using editorService = new BrowserEditorService(parts);
		services.registerInstance(IEditorPart, parts);
		services.registerInstance(IEditorGroupsService, editorService);
		using commands = new CommandService(services);
		const source = auxiliary.activeGroup;
		await commands.executeCommand('workbench.action.splitEditorUp', { groupId: source.id, editorIndex: 0 });
		assert.deepEqual(main.groups.map(group => group.inputs), [[active]]);
		assert.deepEqual(auxiliary.groups.map(group => group.inputs), [[clicked], [clicked]]);
		assert.equal(parts.activePart, auxiliary);
	} finally {
		dom.window.close();
	}
});

test('EditorParts restores main and auxiliary editor windows with their active part', async () => {
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor('test.editor.default', '', () => new TestEditorPane('test.editor.default')));
	const accessibility = {
		onDidChangeScreenReaderOptimized: Event.None,
		isScreenReaderOptimized: () => false,
	} as unknown as IAccessibilityService;
	const firstDom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
	const firstMain = createEditorPart(firstDom.window.document.body, { registry });
	using firstWindows = new TestAuxiliaryWindowService();
	using firstStorage = new BrowserStorageService({ ownerWindow: firstDom.window as unknown as Window, applicationId: 'editor-parts-test', workspaceId: 'workspace', flushInterval: 0 });
	using firstParts = new EditorParts(firstMain, firstWindows, container => createAuxiliaryPart(container, registry), accessibility, firstStorage);
	await firstParts.restoreSavedState(true);
	const mainInput: EditorInput = { resource: URI.parse('file:///C:/project/main.txt') };
	const detachedInput: EditorInput = { resource: URI.parse('file:///C:/project/detached.txt') };
	await firstMain.openEditor(mainInput);
	const detached = await firstParts.createAuxiliaryEditorPart();
	await detached.openEditor(detachedInput);
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	const saved = firstStorage.get('editorparts.state', StorageScope.WORKSPACE);
	assert.ok(saved);
	firstParts.dispose();
	firstMain.dispose();
	firstDom.window.close();

	const restoredDom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
	const restoredMain = createEditorPart(restoredDom.window.document.body, { registry });
	using restoredWindows = new TestAuxiliaryWindowService();
	using restoredStorage = new BrowserStorageService({ ownerWindow: restoredDom.window as unknown as Window, applicationId: 'editor-parts-test', workspaceId: 'workspace', flushInterval: 0 });
	using restoredParts = new EditorParts(restoredMain, restoredWindows, container => createAuxiliaryPart(container, registry), accessibility, restoredStorage);
	restoredStorage.store('editorparts.state', saved, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	await restoredParts.restoreSavedState(true);
	assert.deepEqual(restoredParts.parts.map(part => part.groups.flatMap(group => group.inputs.map(editor => editor.resource.toString()))), [
		[mainInput.resource.toString()],
		[detachedInput.resource.toString()],
	]);
	assert.equal(restoredParts.activePart, restoredParts.parts[1]);
	restoredParts.dispose();
	restoredMain.dispose();
	restoredDom.window.close();
});

test('EditorParts replaces an untitled resource in every group and window', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor('test.editor.default', '', () => new TestEditorPane('test.editor.default')));
	const main = createEditorPart(dom.window.document.body, { registry });
	using windows = new TestAuxiliaryWindowService();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, applicationId: 'editor-parts-test', workspaceId: 'workspace', flushInterval: 0 });
	const editorParts = new EditorParts(main, windows, container => createAuxiliaryPart(container, registry), {
		onDidChangeScreenReaderOptimized: Event.None,
		isScreenReaderOptimized: () => false,
	} as unknown as IAccessibilityService, storage);
	const untitled: EditorInput = { resource: URI.parse('untitled:/Untitled-1'), label: 'Untitled-1' };
	const saved: EditorInput = { resource: URI.file('C:\\project\\draft.txt'), label: 'draft.txt' };
	await editorParts.openEditor(untitled);
	await main.openEditor(untitled, {}, 'sideGroup');
	const auxiliary = await editorParts.createAuxiliaryEditorPart();
	await auxiliary.openEditor(untitled);
	await editorParts.replaceEditorResource(auxiliary.activeGroup, untitled, saved);
	assert.deepEqual(editorParts.groups.map(group => group.inputs.map(input => input.resource.toString())), [[saved.resource.toString()], [saved.resource.toString()], [saved.resource.toString()]]);
	assert.equal(editorParts.activePart, auxiliary);
	editorParts.dispose();
	main.dispose();
	dom.window.close();
});

test("BrowserAuxiliaryWindowService opens, registers, mirrors styles, and releases a popup", async () => {
	const opener = new JSDOM("<!doctype html><head><style>.mirrored { color: red; }</style></head><body></body>", { url: 'https://ash.test/' });
	const popup = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test/auxiliary" });
	const reopenedPopup = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test/auxiliary" });
	let nextPopup = popup;
	let openFeatures = '';
	opener.window.document.documentElement.lang = "zh-Hans";
	const root = opener.window.document.createElement("main");
	root.className = "ash-workbench ash-reduce-motion";
	root.setAttribute("data-os", "windows");
	root.setAttribute("data-runtime", "electron");
	opener.window.document.body.append(root);
	Object.defineProperty(opener.window, "open", {
		configurable: true,
		value: (_url: string, _target: string, features: string) => { openFeatures = features; return nextPopup.window; },
	});
	const missingServices = new InstantiationService();
	assert.throws(() => missingServices.createInstance(BrowserAuxiliaryWindowService, opener.window as unknown as Window, root), /themeService/);
	missingServices.dispose();
	const services = new InstantiationService();
	const themes = new TestThemeService(lightColorTheme);
	services.registerInstance(IThemeService, themes);
	const storage = new BrowserStorageService({ ownerWindow: opener.window as unknown as Window, applicationId: 'ash-test', workspaceId: 'workspace', backend: opener.window.localStorage, flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	const service = services.createInstance(BrowserAuxiliaryWindowService, opener.window as unknown as Window, root);
	const auxiliary = await service.open({ title: "Detached Editor", width: 640, height: 480 });

	assert.equal(auxiliary.container.getAttribute('aria-label'), "Detached Editor");
	assert.equal(auxiliary.window.document.documentElement.lang, "zh-Hans");
	assert.equal(auxiliary.container.ownerDocument, popup.window.document);
	assert.ok(auxiliary.container instanceof opener.window.HTMLElement);
	const child = h(auxiliary.container.ownerDocument, "div");
	auxiliary.container.append(child);
	assert.equal(child.ownerDocument, popup.window.document);
	assert.ok(child instanceof browserEnvironment.window.HTMLElement);
	assert.ok(isHTMLElement(child));
	assert.equal(auxiliary.container.classList.contains("ash-workbench"), true);
	assert.equal(auxiliary.container.classList.contains("ash-reduce-motion"), true);
	assert.equal(auxiliary.container.getAttribute("data-os"), "windows");
	assert.equal(auxiliary.container.getAttribute("data-color-scheme"), lightColorTheme.colorScheme);
	assert.equal(auxiliary.container.style.getPropertyValue("--ash-editor-background"), lightColorTheme.getColorCss("editor.background"));
	assert.match(popup.window.document.head.textContent ?? "", /mirrored/);
	assert.equal(service.getWindow(auxiliary.id), auxiliary);
	Object.defineProperties(popup.window, {
		outerWidth: { configurable: true, value: 740 },
		outerHeight: { configurable: true, value: 560 },
		innerWidth: { configurable: true, value: 724 },
		innerHeight: { configurable: true, value: 521 },
		screenX: { configurable: true, value: 120 },
		screenY: { configurable: true, value: 90 },
	});
	assert.deepEqual(auxiliary.createState(), { width: 740, height: 560, left: 120, top: 90, featureWidthOffset: 0, featureHeightOffset: 0 });
	let closed = 0;
	auxiliary.onDidClose(() => closed++);
	themes.setColorTheme(highContrastDarkColorTheme);
	root.classList.remove("ash-reduce-motion");
	root.classList.add("ash-underline-links");
	await nextTask();
	assert.equal(auxiliary.container.getAttribute("data-color-scheme"), highContrastDarkColorTheme.colorScheme);
	assert.equal(auxiliary.container.style.getPropertyValue("--ash-editor-background"), highContrastDarkColorTheme.getColorCss("editor.background"));
	assert.equal(auxiliary.container.classList.contains("ash-reduce-motion"), false);
	assert.equal(auxiliary.container.classList.contains("ash-underline-links"), true);

	auxiliary[Symbol.dispose]();
	assert.equal(closed, 1);
	assert.equal(service.getWindow(auxiliary.id), undefined);
	nextPopup = reopenedPopup;
	const reopened = await service.open();
	assert.match(openFeatures, /width=740,height=560,x=120,y=90/);
	reopened[Symbol.dispose]();
	service.dispose();
	themes.dispose();
	storage.dispose();
	services.dispose();
	opener.window.close();
	popup.window.close();
	reopenedPopup.window.close();
});

test('workspace shutdown saves an untitled editor through Save As before accepting the transition', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	const untitled: EditorInput = { resource: URI.parse('untitled:/Draft'), label: 'Draft' };
	const destination = URI.file('/project/draft.txt');
	using copy = new TestWorkingCopy(untitled.resource);
	copy.markDirty();
	let savedTo: URI | undefined;
	registry.registerEditorPane({
		id: 'test.save-as', name: 'Save As', canOpen: () => EditorPaneMatch.Default,
		create: () => Object.assign(new TestEditorPane('test.save-as', copy), { saveAs: async (target: URI) => { savedTo = target; await copy.saveAs(); } }),
	});
	using editor = createEditorPart(dom.window.document.body, {
		registry, fileDialogService: new TestFileDialogService(ConfirmResult.SAVE),
		saveAsResource: async () => destination,
		replaceEditorResource: async (group, input, replacement) => { await group.replaceEditor(input, replacement); },
	});
	await editor.openEditor(untitled);
	assert.equal(await editor.confirmCloseAllEditors(), true);
	assert.equal(savedTo?.toString(), destination.toString());
	assert.equal(copy.saveCount, 0);
	assert.equal(editor.activeInput?.resource.toString(), destination.toString());
	dom.window.close();
});

class TestEditorPane extends Disposable implements IEditorPane {
	readonly visibilities: EditorPaneVisibility[] = [];
	inputError: Error | undefined;
	inputPromise: Promise<void> | undefined;
	inputSignal: AbortSignal | undefined;
	dimension: IDimension | undefined;
	focusCount = 0;
	saveCount = 0;
	readonly revealedRanges: Range[] = [];
	get disposed(): boolean { return this.isDisposed; }

	constructor(readonly id: string, readonly workingCopy?: IWorkingCopy) {
		super();
	}

	create(parent: HTMLElement): void {
		const element = h(parent.ownerDocument, "div");
		element.textContent = this.id;
		parent.append(element);
	}

	async setInput(
		_input: EditorInput,
		signal: AbortSignal,
	): Promise<void> {
		this.inputSignal = signal;
		if (this.inputError) throw this.inputError;
		await this.inputPromise;
	}

	clearInput(): void {}

	layout(dimension: IDimension): void {
		this.dimension = {
			width: dimension.width,
			height: dimension.height,
		};
	}

	setVisible(visibility: EditorPaneVisibility): void {
		this.visibilities.push(visibility);
	}

	focus(): void {
		this.focusCount += 1;
	}

	revealRange(range: Range): void {
		this.revealedRanges.push(range);
	}

	async save(): Promise<void> {
		this.saveCount += 1;
	}
}

class TestSelectionPane extends TestEditorPane implements IEditorPaneWithSelection {
	private readonly selectionEmitter = this._register(new Emitter<EditorPaneSelectionChangeReason>());
	readonly onDidChangeSelection = this.selectionEmitter.event;
	private selection = new Range(1, 1, 1, 1);
	lastRestoreSource: TextEditorSelectionSource | undefined;

	getSelection(): Range {
		return this.selection;
	}

	setPosition(line: number, reason: EditorPaneSelectionChangeReason): void {
		this.selection = new Range(line, 1, line, 1);
		this.selectionEmitter.fire(reason);
	}

	restoreSelection(selection: Range, source: TextEditorSelectionSource): void {
		this.selection = selection;
		this.lastRestoreSource = source;
		switch (source) {
			case TextEditorSelectionSource.JUMP:
				this.selectionEmitter.fire(EditorPaneSelectionChangeReason.JUMP);
				break;
			case TextEditorSelectionSource.NAVIGATION:
				this.selectionEmitter.fire(EditorPaneSelectionChangeReason.NAVIGATION);
				break;
			default:
				this.selectionEmitter.fire(EditorPaneSelectionChangeReason.PROGRAMMATIC);
		}
	}
}

class TestViewStateEditorPane extends TestEditorPane implements IEditorPaneWithViewState {
	readonly viewStateTypeId = "test.textView";
	viewState: unknown = null;
	restoredViewState: unknown;

	saveViewState(): unknown { return this.viewState; }
	restoreViewState(state: unknown): void { this.restoredViewState = state; }
}

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyEmitter = this._register(new Emitter<void>());
	private readonly externalChangeEmitter = this._register(new Emitter<void>());
	private readonly contentEmitter = this._register(new Emitter<void>());
	private dirty = false;
	readonly backupKind = "text" as const;
	readonly onDidChangeDirty = this.dirtyEmitter.event;
	readonly onDidChangeExternalChange = this.externalChangeEmitter.event;
	readonly onDidChangeContent = this.contentEmitter.event;
	readonly hasExternalChange = false;
	saveCount = 0;
	revertCount = 0;

	constructor(readonly resource: URI) {
		super();
	}

	get isDirty(): boolean { return this.dirty; }
	backup(): string { return "dirty"; }
	restoreBackup(): void { this.markDirty(); }
	markDirty(): void {
		if (this.dirty) return;
		this.dirty = true;
		this.dirtyEmitter.fire();
	}
	async save(): Promise<void> {
		this.saveCount += 1;
		this.markClean();
	}
	async saveAs(): Promise<void> { this.markClean(); }
	async revert(): Promise<void> {
		this.revertCount += 1;
		this.markClean();
	}
	private markClean(): void {
		if (!this.dirty) return;
		this.dirty = false;
		this.dirtyEmitter.fire();
	}
}

class TestFileDialogService implements IFileDialogService {
	readonly prompts: string[][] = [];
	private readonly results: ConfirmResult[];

	constructor(...results: ConfirmResult[]) {
		this.results = [...results];
	}

	async pickFileToSave(): Promise<never> { throw new Error('Unexpected Save As'); }
	async showSaveDialog(): Promise<never> { throw new Error('Unexpected save dialog'); }
	async showOpenDialog(): Promise<never> { throw new Error('Unexpected open dialog'); }
	async showSaveConfirm(resources: readonly (string | URI)[]): Promise<ConfirmResult> {
		this.prompts.push(resources.map(resource => typeof resource === 'string' ? resource : resource.fsPath));
		return this.results.shift() ?? ConfirmResult.CANCEL;
	}
}

class TestAuxiliaryWindowService extends Disposable implements IAuxiliaryWindowService {
	private readonly openEmitter = this._register(new Emitter<IAuxiliaryWindow>());
	readonly onDidOpenWindow = this.openEmitter.event;
	lastWindow: TestAuxiliaryWindow | undefined;

	async open(_options?: AuxiliaryWindowOpenOptions): Promise<IAuxiliaryWindow> {
		const auxiliary = this._register(new TestAuxiliaryWindow());
		this.lastWindow = auxiliary;
		this.openEmitter.fire(auxiliary);
		return auxiliary;
	}

	getWindow(id: number): IAuxiliaryWindow | undefined {
		return this.lastWindow?.id === id ? this.lastWindow : undefined;
	}
}

class TestAuxiliaryWindow extends Disposable implements IAuxiliaryWindow {
	readonly id = 42;
	private readonly dom = new JSDOM("<!doctype html><body><main></main></body>");
	private readonly layoutEmitter = this._register(new Emitter<IDimension>());
	private readonly beforeUnloadEmitter = this._register(new Emitter<AuxiliaryWindowBeforeUnloadEvent>());
	private readonly closeEmitter = this._register(new Emitter<void>());
	readonly onDidLayout = this.layoutEmitter.event;
	readonly onBeforeUnload = this.beforeUnloadEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	readonly window = this.dom.window as unknown as Window;
	readonly container = this.dom.window.document.querySelector<HTMLElement>("main")!;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.closeEmitter.fire();
			this.dom.window.close();
		}));
	}

	layout(): void {
		this.layoutEmitter.fire({ width: 800, height: 600 });
	}

	createState(): { width: number; height: number; left: number; top: number; featureWidthOffset: number; featureHeightOffset: number } {
		return { width: 800, height: 600, left: 0, top: 0, featureWidthOffset: 0, featureHeightOffset: 0 };
	}

	requestBeforeUnload(): string | undefined {
		let reason: string | undefined;
		this.beforeUnloadEmitter.fire({ veto: candidate => { reason = candidate; } });
		return reason;
	}
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

class TestKeybindingService implements IKeybindingService {
	private readonly _onDidUpdateKeybindings = new Emitter<void>();
	private readonly bindings = new Map<CommandId, ResolvedKeybinding>();

	readonly inChordMode = false;
	readonly onDidUpdateKeybindings = this._onDidUpdateKeybindings.event;

	set(command: CommandId, keybinding: Keybinding): void {
		this.bindings.set(command, resolveKeybinding(keybinding));
		this._onDidUpdateKeybindings.fire();
	}

	resolveKeybinding(keybinding: Keybinding): ResolvedKeybinding {
		return resolveKeybinding(keybinding);
	}

	resolveUserBinding(_userBinding: string): ResolvedKeybinding | undefined {
		return undefined;
	}

	lookupKeybindings(
		command: CommandId,
		_context?: Context,
	): readonly ResolvedKeybinding[] {
		const keybinding = this.lookupKeybinding(command);
		return keybinding ? [keybinding] : [];
	}

	lookupKeybinding(
		command: CommandId,
		_context?: Context,
	): ResolvedKeybinding | undefined {
		return this.bindings.get(command);
	}

	dispose(): void {
		this._onDidUpdateKeybindings.dispose();
	}
}

function descriptor(
	id: string,
	defaultExtension: string,
	create: () => IEditorPane,
): IEditorPaneDescriptor {
	return {
		id,
		name: id,
		canOpen: (candidate) =>
			candidate.resource.path.endsWith(defaultExtension)
				? EditorPaneMatch.Default
				: EditorPaneMatch.Optional,
		create,
	};
}

function input(path: string): EditorInput {
	return { resource: URI.file(path) };
}

function trackPane(
	panes: TestEditorPane[],
	id: string,
): TestEditorPane {
	const pane = new TestEditorPane(id);
	panes.push(pane);
	return pane;
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}


test('ignored open errors leave the active file intact and report the original error', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	const failure = new Error('Access denied');
	registry.registerEditorPane(descriptor('test.editor.working', '.ok', () => new TestEditorPane('test.editor.working')));
	registry.registerEditorPane(descriptor('test.editor.failed', '.bad', () => {
		const pane = new TestEditorPane('test.editor.failed');
		pane.inputError = failure;
		return pane;
	}));
	try {
		using editor = createEditorPart(dom.window.document.body, { registry });
		const working = input('C:/project/working.ok');
		await editor.openEditor(working);
		await assert.rejects(editor.openEditor(input('C:/project/failed.bad'), { ignoreError: true }), error => error === failure);
		assert.deepEqual(editor.activeGroup.inputs, [working]);
		assert.equal(editor.domNode.querySelector('.ash-editor-open-error'), null);
	} finally {
		dom.window.close();
	}
});

test('cancelled opens do not create an error page', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane(descriptor('test.editor.cancelled', '.cancelled', () => {
		const pane = new TestEditorPane('test.editor.cancelled');
		pane.inputError = new CancellationError();
		return pane;
	}));
	try {
		using editor = createEditorPart(dom.window.document.body, { registry });
		await assert.rejects(editor.openEditor(input('C:/project/document.cancelled')), CancellationError);
		assert.equal(editor.activeGroup.inputs.length, 0);
		assert.equal(editor.domNode.querySelector('.ash-editor-open-error'), null);
	} finally {
		dom.window.close();
	}
});

test('error pages render severity and run the supplied action without duplicating a tab', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	let attempts = 0;
	let editor: InstanceType<typeof EditorPart>;
	const resource = input('C:/project/document.custom');
	registry.registerEditorPane(descriptor('test.editor.custom', '.custom', () => {
		const pane = new TestEditorPane('test.editor.custom');
		if (attempts++ === 0) {
			pane.inputError = createEditorOpenError('Choose a compatible viewer', [{
				id: 'test.openViewer', label: 'Use viewer', tooltip: '', enabled: true,
				run: () => editor.openEditor(resource),
			}], { forceMessage: true, forceSeverity: Severity.Info });
		}
		return pane;
	}));
	try {
		editor = createEditorPart(dom.window.document.body, { registry });
		using editorLifetime = editor;
		await editor.openEditor(resource);
		const page = editor.domNode.querySelector<HTMLElement>('.ash-editor-open-error');
		assert.equal(page?.getAttribute('role'), 'status');
		assert.equal(page?.querySelector('h2')?.textContent, 'Choose a compatible viewer');
		editor.focus();
		const action = page?.querySelector<HTMLButtonElement>('button');
		assert.equal(action, dom.window.document.activeElement);
		action?.click();
		await nextTask();
		assert.deepEqual({ pane: editor.activePane?.id, tabs: editor.activeGroup.inputs.length, attempts }, { pane: 'test.editor.custom', tabs: 1, attempts: 2 });
	} finally {
		dom.window.close();
	}
});

test('the error dialog preference applies immediately and automatic opens remain quiet', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	let actionRuns = 0;
	registry.registerEditorPane(descriptor('test.editor.dialog', '.dialog', () => {
		const pane = new TestEditorPane('test.editor.dialog');
		pane.inputError = createEditorOpenError('Choose a recovery action', [{
			id: 'test.recover', label: 'Recover', tooltip: '', enabled: true,
			run: () => { actionRuns++; },
		}], { forceMessage: true, forceSeverity: Severity.Warning, allowDialog: true });
		return pane;
	}));
	try {
		using dialogs = new DialogService();
		using configurationService = new InMemoryConfigurationService();
		using editor = createEditorPart(dom.window.document.body, { registry, dialogService: dialogs, configurationService });
		await editor.openEditor(input('C:/project/restored.dialog'));
		assert.equal(dialogs.model.dialogs.length, 0);
		await assert.rejects(configurationService.updateValue(EditorOpenErrorDialogConfiguration, 'false'), TypeError);
		await configurationService.updateValue(EditorOpenErrorDialogConfiguration, false);
		const quietInput = input('C:/project/quiet.dialog');
		await editor.openEditor(quietInput, { source: EditorOpenSource.USER });
		assert.equal(dialogs.model.dialogs.length, 0);
		assert.equal(editor.activeInput, quietInput);
		assert.equal(editor.activePane?.id, 'workbench.editor.openError');
		await configurationService.updateValue(EditorOpenErrorDialogConfiguration, undefined);
		const opening = editor.openEditor(input('C:/project/chosen.dialog'), { source: EditorOpenSource.USER });
		await nextTask();
		const dialog = dialogs.model.dialogs[0];
		assert.equal(dialog?.request.message, 'Choose a recovery action');
		dialog?.close({ button: DialogResult.Primary, buttonIndex: 0 });
		await opening;
		assert.equal(actionRuns, 1);
		assert.equal(dialogs.model.dialogs.length, 0);
	} finally {
		dom.window.close();
	}
});

test('modal file failures use the same retryable error page', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	dom.window.HTMLElement.prototype.scrollTo = () => undefined;
	const registry = new EditorPaneRegistry();
	let attempts = 0;
	registry.registerEditorPane(descriptor('test.editor.modalRetry', '.retry', () => {
		const pane = new TestEditorPane('test.editor.modalRetry');
		if (attempts++ === 0) pane.inputError = new Error('Temporarily unavailable');
		return pane;
	}));
	try {
		using editor = createEditorPart(dom.window.document.body, { registry });
		await editor.openEditor(input('C:/project/modal.retry'), {}, 'modalGroup');
		assert.equal(editor.isModalEditorVisible, true);
		const error = dom.window.document.querySelector('.ash-modal-editor .ash-editor-open-error');
		assert.ok(error);
		error.querySelector<HTMLButtonElement>('button')?.click();
		await nextTask();
		assert.equal(editor.activePane?.id, 'test.editor.modalRetry');
		assert.equal(dom.window.document.querySelector('.ash-modal-editor .ash-editor-open-error'), null);
	} finally {
		dom.window.close();
	}
});


test('a missing file offers creation and retries into the same pinned tab', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = new EditorPaneRegistry();
	const missing = input('C:/project/missing.txt');
	let created = false;
	registry.registerEditorPane(descriptor('test.editor.missing', '.txt', () => {
		const pane = new TestEditorPane('test.editor.missing');
		if (!created) pane.inputError = new FileNotFoundError(missing.resource);
		return pane;
	}));
	const files = { createFile: async (resource: URI, existing: string) => {
		assert.equal(resource.toString(), missing.resource.toString());
		assert.equal(existing, 'error');
		created = true;
	} } as unknown as IFileService;
	try {
		using editor = createEditorPart(dom.window.document.body, { registry, fileService: files });
		await editor.openEditor(missing, { pinned: false });
		const create = [...editor.domNode.querySelectorAll<HTMLButtonElement>('.ash-editor-open-error button')].find(button => button.textContent === 'Create file');
		assert.ok(create);
		create.click();
		await nextTask();
		assert.deepEqual({ created, pane: editor.activePane?.id, count: editor.activeGroup.inputs.length, preview: editor.activeGroup.isPreview(missing) }, { created: true, pane: 'test.editor.missing', count: 1, preview: false });
	} finally {
		dom.window.close();
	}
});
