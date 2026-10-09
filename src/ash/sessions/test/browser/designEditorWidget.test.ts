import { createTestFileService } from '../../../workbench/test/common/testEditorServices.js';
import { IAssetService } from '../../../platform/assets/common/assetService.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateUuid } from '../../../base/common/uuid.js';
import { Separator } from '../../../base/common/actions.js';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { DesignConfiguration } from '../../contrib/creator/common/config/editorConfiguration.js';
import { Emitter, Event as AshEvent, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import type { IContextMenuDelegate } from '../../../base/browser/contextmenu.js';
import { IContextMenuService, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { ContextView } from '../../../base/browser/ui/contextview/contextview.js';
import type { DesignEditorContributionContext } from '../../contrib/creator/browser/designEditorBrowser.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { FileKind, FileRevisionConflictError, FileNotFoundError, IFileService, type IFileWriteRequest, type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { BrowserWorkingCopyService } from '../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService } from '../../../workbench/services/workingCopy/common/workingCopyService.js';

import { ILifecycleService, LifecyclePhase, StartupKind, type IBeforeShutdownEvent } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { setARIAContainer } from '../../../base/browser/ui/aria/aria.js';
import { ISessionsLayoutService } from '../../services/layout/common/sessionsLayoutService.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
browser.window.HTMLElement.prototype.scrollTo = function (left: number | ScrollToOptions = {}, top?: number): void {
	this.scrollLeft = typeof left === 'number' ? left : left.left ?? this.scrollLeft;
	this.scrollTop = typeof left === 'number' ? top ?? this.scrollTop : left.top ?? this.scrollTop;
};
for (const [name, value] of Object.entries({
	window: browser.window,
	document: browser.window.document,
	Node: browser.window.Node,
	Element: browser.window.Element,
	HTMLElement: browser.window.HTMLElement,
	Event: browser.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { documentFromShapes, parseDesignDocument, serializeDesignDocument } = await import('../../contrib/creator/common/model/document.js');
const { DesignEditorWidget } = await import('../../contrib/creator/browser/widget/designEditorWidget.js');
const { DesignDocumentController } = await import('../../contrib/creator/browser/designDocumentController.js');
const { DesignEditorPage } = await import('../../contrib/creator/browser/designEditorPage.js');
const { DesignEditorService, IDesignEditorService } = await import('../../contrib/creator/browser/designEditorService.js');
const { DesignLayersView, DesignPropertiesView } = await import('../../contrib/creator/browser/designViews.js');
const { CreatorMode } = await import('../../contrib/creator/common/creator.js');
const { CreatorPage } = await import('../../contrib/creator/browser/creatorPage.js');
await import('../../contrib/creator/browser/creator.contribution.js');
await import('../../contrib/creator/contrib/design/browser/design.contribution.js');
await import('../../contrib/creator/contrib/whiteboard/browser/whiteboard.contribution.js');
await import('../../contrib/creator/contrib/slides/browser/slides.contribution.js');
await import('../../contrib/creator/contrib/brand/browser/brand.contribution.js');
await import('../../contrib/creator/contrib/sites/browser/sites.contribution.js');
await import('../../contrib/creator/contrib/make/browser/make.contribution.js');
await import('../../contrib/creator/contrib/prototype/browser/prototype.contribution.js');
const DESIGN_EDITOR_RESOURCE = URI.parse('ash-creator:/design');
await import('../../contrib/creator/browser/creatorEditor.contribution.js');
const { createDesignEditorContributions } = await import('../../contrib/creator/design.main.js');
const services = new InstantiationService();
services.registerSingleton(IUriIdentityService, () => services.createInstance(UriIdentityService));
const colorContextView = new ContextView(browser.window.document.body);
services.registerInstance(IContextViewService, Object.assign(colorContextView, { container: browser.window.document.body }));
const contextKeys = new ContextKeyService();
const configuration = new WorkbenchConfigurationService();
const theme = new TestThemeService(lightColorTheme);
const commandService = services.invokeFunction(accessor => new CommandService(accessor));
services.registerInstance(ICommandService, commandService);
services.registerInstance(IContextKeyService, contextKeys);
services.registerSingleton(IWorkingCopyService, () => services.createInstance(BrowserWorkingCopyService));
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IThemeService, theme);
services.registerInstance(IWorkspaceContextService, new WorkspaceContextService({ id: 'design-test', folders: [] }));
const resource = URI.file('/design.ash-design');
const binaryFiles = new Map<string, Uint8Array>();
const directories = new Set<string>();
let fileContent = '';
let revision = '0';
let errors: string[] = [];
let saveDecision = ConfirmResult.DONT_SAVE;
const writes: IFileWriteRequest[] = [];
const unexpected = async (): Promise<never> => { throw new Error('Unexpected service call'); };
let contextMenu: IContextMenuDelegate | undefined;
services.registerInstance(IContextMenuService, {
	onDidShowContextMenu: AshEvent.None,
	onDidHideContextMenu: AshEvent.None,
	showContextMenu: delegate => {
		contextMenu?.onHide?.(true);
		contextMenu = delegate as IContextMenuDelegate;
	},
	hideContextMenu: () => { contextMenu?.onHide?.(true); contextMenu = undefined; },
});
services.registerInstance(IFileDialogService, { pickFileToSave: unexpected, showSaveConfirm: async () => saveDecision, showSaveDialog: async () => resource, showOpenDialog: async () => [resource] });
services.registerInstance(IDialogService, { onWillShowDialog: AshEvent.None, onDidShowDialog: AshEvent.None, showMessage: unexpected, info: unexpected, warn: unexpected, error: async message => { errors.push(message); }, confirm: unexpected, prompt: unexpected, input: unexpected, about: unexpected });
services.registerInstance(IAssetService, { getCatalog: unexpected, updateEntry: unexpected, createCollection: unexpected, deleteCollection: unexpected, importImage: unexpected, getVersion: unexpected, readVersion: unexpected });
services.registerInstance(ISessionsLayoutService, { conversationVisible: false, onDidChangeConversationVisibility: AshEvent.None, setConversationVisible: unexpected, openEntry: unexpected, restore: unexpected });
const fileProvider: IFileSystemProvider = {
	capabilities: FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy,
	onDidChangeCapabilities: Event.None,
	watch: (): IDisposable => Disposable.None,

	onDidChangeFiles: AshEvent.None,
	stat: async target => {
		if (directories.has(target.toString())) { return { resource: target, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }; }
		if (binaryFiles.has(target.toString()) || !target.path.includes('/assets/')) { return { resource: target, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }; }
		throw new FileNotFoundError(target);
	},
	readDirectory: unexpected,
	readFile: async target => {
		const bytes = binaryFiles.get(target.toString());
		if (bytes) return { resource: target, bytes, revision: 'binary' };
		if (target.path.includes('/assets/') || !fileContent) throw new FileNotFoundError(target);
		return { resource: target, bytes: new TextEncoder().encode(fileContent), revision };
	},
	createDirectory: async target => { directories.add(target.toString()); return { resource: target, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }; },
	createFile: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
	writeFile: async (resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> => {
		if (!options.overwrite) {
			binaryFiles.set(resource.toString(), bytes);
			return { revision: 'binary', stat: { resource, kind: FileKind.File, sizeBytes: bytes.length, readonly: false, modifiedAtMillis: undefined } };
		}
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		writes.push(request);
		if (request.expectedRevision !== undefined && request.expectedRevision !== revision) { throw new FileRevisionConflictError(resource); }
		fileContent = request.content;
		revision = `${Number(revision) + 1}`;
		return { revision, stat: { resource, kind: FileKind.File, sizeBytes: fileContent.length, readonly: false, modifiedAtMillis: undefined } };
	},
};
services.registerSingleton(IFileService, () => createTestFileService(fileProvider));
services.registerInstance(ILifecycleService, { startupKind: StartupKind.NewWindow, phase: LifecyclePhase.Ready, willShutdown: false, onBeforeShutdown: AshEvent.None, onBeforeShutdownError: AshEvent.None, onShutdownVeto: AshEvent.None, onWillShutdown: AshEvent.None, onDidShutdownError: AshEvent.None, onDidShutdown: AshEvent.None, when: async () => { }, shutdown: async () => { } });

suiteTeardown(() => {
	colorContextView.dispose();
	services.dispose();
	contextKeys.dispose();
	configuration.dispose();
	theme.dispose();
	commandService.dispose();
	browser.window.close();
});

interface ProjectedTransform { panX: number; panY: number; scale: number; }

class DesignEditorFixture extends Disposable {
	readonly pane: InstanceType<typeof DesignEditorPage>;
	readonly designEditors: InstanceType<typeof DesignEditorService>;
	readonly domNode: HTMLElement;
	readonly propertiesDomNode: HTMLElement;
	readonly layersDomNode: HTMLElement;

	constructor() {
		super();
		const child = services.createChild();
		this.designEditors = this._register(child.createInstance(DesignEditorService));
		child.registerInstance(IDesignEditorService, this.designEditors);
		const ownerDocument = browser.window.document;
		const editorHost = ownerDocument.createElement('section');
		editorHost.dataset.part = 'editor';
		this.propertiesDomNode = ownerDocument.createElement('section');
		this.propertiesDomNode.dataset.part = 'auxiliarybar';
		this.layersDomNode = ownerDocument.createElement('section');
		this.layersDomNode.dataset.part = 'sidebar';
		ownerDocument.body.append(editorHost, this.propertiesDomNode, this.layersDomNode);
		this.pane = this._register(child.createInstance(DesignEditorPage, CreatorMode.Design));
		this.pane.create(editorHost);
		this.domNode = this.pane.domNode;
		const properties = this._register(child.createInstance(DesignPropertiesView, this.propertiesDomNode, { id: 'design.properties', title: 'Shape properties' }));
		const layers = this._register(child.createInstance(DesignLayersView, this.layersDomNode, { id: 'design.layers', title: 'Layers' }));
		properties.setVisible(true);
		layers.setVisible(true);
		this.pane.setVisible(true);
		this._register(child);
		this._register(toDisposable(() => { editorHost.remove(); this.propertiesDomNode.remove(); this.layersDomNode.remove(); }));
	}
	focus(): void { this.pane.focus(); }
	layout(dimension: { width: number; height: number; }): void { this.pane.layout(dimension); }
}

function createView(): DesignEditorFixture {
	const view = new DesignEditorFixture();
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	let captured: number | undefined;
	viewport.setPointerCapture = id => { captured = id; };
	viewport.hasPointerCapture = id => captured === id;
	viewport.releasePointerCapture = () => { captured = undefined; };
	Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
	return view;
}

function projectedTransform(view: { readonly domNode: HTMLElement; }): ProjectedTransform {
	const transform = view.domNode.querySelector<HTMLElement>('.ash-canvas-world')!.style.transform;
	const match = transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)!;
	return { panX: Number(match[1]), panY: Number(match[2]), scale: Number(match[3]) };
}

function dispatchWheel(view: { readonly domNode: HTMLElement; }, init: WheelEventInit & { clientX?: number; clientY?: number; }): void {
	view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!
		.dispatchEvent(new browser.window.WheelEvent('wheel', { cancelable: true, ...init }));
}

test('Design cursor follows configuration and theme changes and releases its subscriptions', async () => {
	const view = createView();
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	const cursor = () => viewport.style.getPropertyValue('--ash-canvas-pointer-cursor');
	try {
		assert.equal(viewport.classList.contains('pointer-cursor'), true);
		assert.match(decodeURIComponent(cursor()), /width="24" height="24"/u);
		const initialCursor = cursor();
		theme.setColorTheme(darkColorTheme);
		assert.notEqual(cursor(), initialCursor);
		await configuration.updateValue(DesignConfiguration.usePointerCursor, false);
		assert.equal(viewport.classList.contains('pointer-cursor'), false);
		assert.equal(configuration.inspect(DesignConfiguration.usePointerCursor).userValue, false);
		using nextView = createView();
		assert.equal(nextView.domNode.querySelector('.ash-canvas-viewport')!.classList.contains('pointer-cursor'), false);
		await assert.rejects(configuration.updateValue(DesignConfiguration.usePointerCursor, 'false'), /must be boolean/u);
		await assert.rejects(configuration.updateValue(DesignConfiguration.usePointerCursor, false, ConfigurationTarget.WORKSPACE), /Unable to write/u);
		view.dispose();
		const disposedCursor = cursor();
		await configuration.updateValue(DesignConfiguration.usePointerCursor, true);
		theme.setColorTheme(lightColorTheme);
		assert.equal(viewport.classList.contains('pointer-cursor'), false);
		assert.equal(cursor(), disposedCursor);
	} finally {
		view.dispose();
		await configuration.updateValue(DesignConfiguration.usePointerCursor, undefined);
		theme.setColorTheme(lightColorTheme);
	}
});

test('Design canvas exposes a named focusable region and starts at identity', () => {
	const view = createView();
	try {
		assert.equal(view.domNode.getAttribute('role'), 'region');
		assert.equal(view.domNode.getAttribute('aria-label'), 'Design canvas');
		assert.equal(view.domNode.getAttribute('tabindex'), '0');
		assert.equal(projectedTransform(view).scale, 1);
		view.domNode.focus();
		assert.equal(document.activeElement, view.domNode);
	} finally {
		view.dispose();
	}
});

test('Design canvas pans with plain wheel input and keeps the camera convention', () => {
	const view = createView();
	try {
		dispatchWheel(view, { deltaX: 40, deltaY: 120 });
		assert.deepEqual(projectedTransform(view), { panX: -40, panY: -120, scale: 1 });
	} finally {
		view.dispose();
	}
});

test('Design canvas zooms toward the pointer on Ctrl+wheel', () => {
	const view = createView();
	try {
		dispatchWheel(view, { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 40 });
		const { panX, panY, scale } = projectedTransform(view);
		assert.ok(Math.abs(scale - Math.exp(0.5)) < 1e-9, `unexpected scale ${scale}`);
		assert.ok(Math.abs((50 - panX) / scale - 50) < 1e-9, 'world point under the cursor moved horizontally');
		assert.ok(Math.abs((40 - panY) / scale - 40) < 1e-9, 'world point under the cursor moved vertically');
	} finally {
		view.dispose();
	}
});

test('Design canvas clamps zoom between its limits', () => {
	const view = createView();
	try {
		dispatchWheel(view, { deltaY: -1_000_000, ctrlKey: true, clientX: 0, clientY: 0 });
		assert.equal(projectedTransform(view).scale, 4);
		dispatchWheel(view, { deltaY: 1_000_000, ctrlKey: true, clientX: 0, clientY: 0 });
		assert.equal(projectedTransform(view).scale, 0.2);
	} finally {
		view.dispose();
	}
});

test('Design canvas pans and zooms from the keyboard and resets with 0', () => {
	const view = createView();
	view.layout({ width: 200, height: 100 });
	const canvas = view.domNode;
	try {
		canvas.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true, bubbles: true }));
		assert.equal(projectedTransform(view).panX, 60);
		canvas.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: '=', cancelable: true, bubbles: true }));
		const { panX, panY, scale } = projectedTransform(view);
		assert.ok(Math.abs(scale - 1.2) < 1e-9, `unexpected scale ${scale}`);
		assert.ok(Math.abs(panX - (100 - (100 - 60) * 1.2)) < 1e-9, 'zoom is not anchored at the canvas center horizontally');
		assert.ok(Math.abs(panY - (50 - 50 * 1.2)) < 1e-9, 'zoom is not anchored at the canvas center vertically');
		canvas.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: '0', cancelable: true, bubbles: true }));
		assert.deepEqual(projectedTransform(view), { panX: 0, panY: 0, scale: 1 });
	} finally {
		view.dispose();
	}
});

test('Design canvas pans by dragging with the pointer', () => {
	const view = createView();
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	const firePointer = (type: string, x: number, y: number): void => {
		viewport.dispatchEvent(new browser.window.PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
	};
	try {
		firePointer('pointerdown', 10, 10);
		assert.ok(viewport.classList.contains('panning'));
		firePointer('pointermove', 40, 25);
		firePointer('pointerup', 40, 25);
		assert.deepEqual(projectedTransform(view), { panX: 30, panY: 15, scale: 1 });
		assert.ok(!viewport.classList.contains('panning'));
	} finally {
		view.dispose();
	}
});

test('Design canvas resolves its accessible name from the Chinese language pack', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	const view = createView();
	try {
		assert.equal(view.domNode.getAttribute('aria-label'), '设计画布');
	} finally {
		view.dispose();
		resetNlsResolver();
	}
});

test('Design color formats preserve alpha, reject invalid values and share document undo', () => {
	using view = createView();
	view.domNode.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
	const model = view.designEditors.document.model;
	view.propertiesDomNode.querySelector<HTMLButtonElement>('button[aria-label="Fill"]')!.click();
	const picker = browser.window.document.querySelector<HTMLElement>('.ash-color-picker')!;
	const format = picker.querySelector<HTMLSelectElement>('select')!;
	assert.deepEqual(Array.from(format.options, option => option.text), ['Hex', 'RGB', 'CSS', 'HSL', 'HSB']);
	const alpha = picker.querySelector<HTMLInputElement>('input[aria-label="Opacity (%)"]')!;
	alpha.value = '25'; alpha.dispatchEvent(new browser.window.Event('change'));
	const fill = model.value.shapes[0].fill;
	assert.equal(fill, '#80808040');
	const version = model.version;
	for (const value of ['rgb', 'css', 'hsl', 'hsb', 'hex']) {
		format.value = value; format.dispatchEvent(new browser.window.Event('change'));
		assert.equal(model.version, version);
		assert.equal(model.value.shapes[0].fill, fill);
	}
	const value = picker.querySelector<HTMLInputElement>('input[aria-label="Color value"]')!;
	value.value = 'invalid'; value.dispatchEvent(new browser.window.Event('change'));
	assert.equal(value.getAttribute('aria-invalid'), 'true');
	assert.equal(model.version, version);
	value.value = '#ff0000'; value.dispatchEvent(new browser.window.Event('change'));
	assert.equal(model.value.shapes[0].fill, '#ff000040');
	assert.equal(alpha.value, '25');
	format.value = 'hsb'; format.dispatchEvent(new browser.window.Event('change'));
	const brightness = picker.querySelector<HTMLInputElement>('input[aria-label="HSB B"]')!;
	brightness.value = '50'; brightness.dispatchEvent(new browser.window.Event('change'));
	assert.equal(model.value.shapes[0].fill, '#80000040');
	view.designEditors.document.model.undo();
	assert.equal(model.value.shapes[0].fill, '#ff000040');
	assert.equal(colorContextView.visible, false);
});

test('Design color preview cancels without editing and one committed range gesture undoes once', () => {
	using view = createView();
	view.domNode.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
	const model = view.designEditors.document.model;
	const fillButton = view.propertiesDomNode.querySelector<HTMLButtonElement>('button[aria-label="Fill"]')!;
	// jsdom has no layout; model the painted trigger without making hidden or detached targets visible.
	Object.defineProperty(fillButton, 'getClientRects', {
		value(this: Element): readonly DOMRect[] {
			if (!this.isConnected || this.closest('[hidden]')) return [];
			for (let element: Element | null = this; element; element = element.parentElement) {
				if (browser.window.getComputedStyle(element).display === 'none') return [];
			}
			return [new browser.window.DOMRect(0, 0, 100, 20)];
		},
	});
	fillButton.focus(); fillButton.click();
	const picker = browser.window.document.querySelector<HTMLElement>('.ash-color-picker')!;
	const alpha = picker.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
	const initial = model.version;
	for (const value of ['80', '60', '40']) {
		alpha.value = value; alpha.dispatchEvent(new browser.window.Event('input'));
	}
	assert.equal(model.version, initial);
	assert.equal(view.domNode.querySelector('rect[data-shape-id]')!.getAttribute('fill'), '#80808066');
	alpha.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(model.version, initial);
	assert.equal(view.domNode.querySelector('rect[data-shape-id]')!.getAttribute('fill'), '#808080');
	assert.equal(browser.window.document.activeElement, fillButton);
	fillButton.click();
	for (const value of ['90', '70', '50']) { alpha.value = value; alpha.dispatchEvent(new browser.window.Event('input')); }
	alpha.dispatchEvent(new browser.window.Event('change'));
	assert.equal(model.value.shapes[0].fill, '#80808080');
	view.designEditors.document.model.undo();
	assert.equal(model.value.shapes[0].fill, '#808080');
	view.designEditors.document.model.redo();
	assert.equal(model.value.shapes[0].fill, '#80808080');
});

test('Design color picker uses Chinese labels and releases its overlay when the editor is hidden', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		view.domNode.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
		view.propertiesDomNode.querySelector<HTMLButtonElement>('button[aria-label="填充"]')!.click();
		const picker = browser.window.document.querySelector<HTMLElement>('.ash-color-picker')!;
		assert.match(picker.getAttribute('aria-label')!, /^颜色选择器/u);
		assert.ok(picker.querySelector('[aria-label="颜色格式"]'));
		assert.ok(picker.querySelector('[aria-label="饱和度和亮度"]'));
		assert.ok(picker.querySelector('[aria-label="文档颜色"]'));
		view.pane.setVisible(false);
		assert.equal(colorContextView.visible, false);
	} finally { resetNlsResolver(); }
});

function pressCanvas(view: { readonly domNode: HTMLElement; }, key: string, options: KeyboardEventInit = {}): void {
	view.domNode.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...options }));
}

async function clickAction(view: { readonly domNode: HTMLElement; }, name: string): Promise<void> {
	const button = Array.from(view.domNode.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === name || button.textContent === name)!;
	button.click();
	// File-service promises are immediate in this fixture, but the action crosses several async boundaries.
	for (let index = 0; index < 20; index++) { await Promise.resolve(); }
}

async function clickCanvasMenu(view: { readonly domNode: HTMLElement; }, name: string): Promise<void> {
	pressCanvas(view, 'F10', { shiftKey: true });
	const action = contextMenu!.getActions().find(action => action.label === name)!;
	assert.equal(action.enabled, true);
	services.get(IContextMenuService).hideContextMenu();
	await action.run();
}

test('Design canvas menu keeps selection, applies edits and disappears with its editor', async () => {
	const view = createView();
	try {
		view.layout({ width: 400, height: 300 });
		assert.equal(view.domNode.querySelector('.ash-sessions-design-tools'), null);
		pressCanvas(view, 'ContextMenu');
		assert.deepEqual(contextMenu!.getActions().filter(action => !(action instanceof Separator)).map(action => [action.label, action.enabled]), [
			['Undo', false], ['Redo', false], ['Delete', false], ['Select all', false],
			['Duplicate image', false], ['Group', false], ['Ungroup', false], ['Add frame (F)', true], ['Import image', true], ['Export SVG', false], ['Open design', true],
		]);
		pressCanvas(view, 'r');
		pressCanvas(view, 'e');
		pressCanvas(view, 'ArrowRight', { shiftKey: true });
		await clickCanvasMenu(view, 'Select all');
		const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
		viewport.dispatchEvent(new browser.window.MouseEvent('contextmenu', { clientX: 150, clientY: 50, bubbles: true, cancelable: true }));
		assert.equal(view.domNode.querySelector('.ash-sessions-design-message')!.textContent, '2 objects selected.');
		assert.equal(contextMenu!.getActions().find(action => action.label === 'Group')!.enabled, true);
		await clickCanvasMenu(view, 'Group');
		assert.equal(view.domNode.querySelectorAll('.ash-sessions-design-shapes > svg[data-shape-id]').length, 1);
		await clickCanvasMenu(view, 'Ungroup');
		pressCanvas(view, 'Escape');
		viewport.dispatchEvent(new browser.window.MouseEvent('contextmenu', { clientX: 145, clientY: 50, bubbles: true, cancelable: true }));
		assert.equal(view.domNode.querySelector('.ash-sessions-design-message')!.textContent, '1 objects selected.');
		await clickCanvasMenu(view, 'Delete');
		assert.equal(view.domNode.querySelector('rect[data-shape-id]'), null);
		assert.equal(view.domNode.querySelectorAll('ellipse[data-shape-id]').length, 1);
		await clickCanvasMenu(view, 'Undo');
		assert.equal(view.domNode.querySelectorAll('rect[data-shape-id]').length, 1);
		pressCanvas(view, 'F10', { shiftKey: true });
		view.dispose();
		assert.equal(contextMenu, undefined);
	} finally { view.dispose(); }
});

test('Design edits render fractional geometry, keep input editing separate and undo a whole drag', () => {
	using view = createView();
	view.layout({ width: 200, height: 100 });
	pressCanvas(view, 'r');
	const rect = view.domNode.querySelector<SVGRectElement>('[data-shape-id]')!;
	const width = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
	width.value = '120.5';
	width.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	width.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
	assert.equal(rect.getAttribute('width'), '120.5');
	pressCanvas(view, '+');
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	const fire = (type: string, x: number): void => { viewport.dispatchEvent(new browser.window.PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 50, bubbles: true })); };
	const before = Number(rect.getAttribute('x'));
	fire('pointerdown', 100);
	fire('pointermove', 124);
	fire('pointermove', 148);
	fire('pointerup', 148);
	assert.equal(Number(rect.getAttribute('x')), before + 40);
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(Number(rect.getAttribute('x')), before);
	DesignEditorWidget.getFocused(view.domNode)!.redo();
	assert.equal(Number(rect.getAttribute('x')), before + 40);
	fire('pointerdown', 148);
	fire('pointermove', 172);
	pressCanvas(view, 'Escape');
	fire('pointerup', 172);
	assert.equal(Number(rect.getAttribute('x')), before + 40);
});

test('Design saves and reopens the complete document, rejecting stale writes and invalid files', async () => {
	using view = createView();
	view.layout({ width: 200, height: 100 });
	errors = [];
	writes.length = 0;
	revision = '0';
	saveDecision = ConfirmResult.DONT_SAVE;
	pressCanvas(view, 'r');
	await DesignEditorWidget.getFocused(view.domNode)!.saveDocument();
	const saved = fileContent;
	assert.equal(view.domNode.classList.contains('dirty'), false);
	pressCanvas(view, 'e');
	await clickCanvasMenu(view, 'Open design');
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 1);
	assert.equal(parseDesignDocument(saved).shapes[0].kind, 'rectangle');
	pressCanvas(view, 'Tab');
	pressCanvas(view, 'ArrowRight');
	revision = '99';
	await DesignEditorWidget.getFocused(view.domNode)!.saveDocument();
	assert.equal(writes.at(-1)!.expectedRevision, '1');
	assert.equal(view.domNode.classList.contains('dirty'), true);
	assert.equal(fileContent, saved);
	assert.equal(errors.length, 1);
	fileContent = '{"version":1,"shapes":[{"kind":"rectangle"}]}';
	await clickCanvasMenu(view, 'Open design');
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 1);
	assert.equal(view.domNode.classList.contains('dirty'), true);
	assert.equal(errors.length, 2);
	saveDecision = ConfirmResult.CANCEL;
	await clickCanvasMenu(view, 'Open design');
	assert.equal(errors.length, 2);
	saveDecision = ConfirmResult.DONT_SAVE;
});

test('Design keyboard selection and Chinese properties expose the document content', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		pressCanvas(view, 'r');
		pressCanvas(view, 'e');
		pressCanvas(view, 'Escape');
		pressCanvas(view, 'Tab');
		assert.equal(view.propertiesDomNode.querySelector('input[aria-label="宽度"]') !== null, true);
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /矩形[\s\S]*椭圆/u);
		pressCanvas(view, 'Delete');
		assert.equal(view.domNode.querySelector('[data-shape-id]')!.tagName, 'ellipse');
	} finally { resetNlsResolver(); }
});

test('Design edits text and path nodes, groups a selection, and exports safe SVG without changing save state', async () => {
	using view = createView();
	view.layout({ width: 400, height: 300 });
	pressCanvas(view, 't');
	const text = view.propertiesDomNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text content"]')!;
	text.value = '中文 <script>alert(1)</script>\nSecond line';
	text.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /中文 <script>/u);
	assert.equal(view.domNode.querySelector('script'), null);
	assert.equal(view.domNode.querySelectorAll('tspan').length, 2);
	pressCanvas(view, 'p');
	const outgoing = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Outgoing handle X"]')!;
	outgoing.value = '48';
	outgoing.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(view.domNode.querySelector('path[data-shape-id]')!.getAttribute('d')!, /C 188 10/u);
	await clickCanvasMenu(view, 'Add node');
	assert.equal(view.propertiesDomNode.querySelector<HTMLSelectElement>('select[aria-label="Path node"]')!.options.length, 3);
	await clickCanvasMenu(view, 'Remove node');
	const closed = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Closed path"]')!;
	closed.click();
	assert.match(view.domNode.querySelector('path[data-shape-id]')!.getAttribute('d')!, / Z$/u);
	pressCanvas(view, 'n');
	pressCanvas(view, 'g');
	assert.equal(view.domNode.querySelectorAll('svg[data-shape-id] > [data-shape-id]').length, 2);
	const width = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
	width.value = '480';
	width.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(view.propertiesDomNode.querySelector('input[aria-label="Height"]')!.getAttribute('type'), 'number');
	await DesignEditorWidget.getFocused(view.domNode)!.saveDocument();
	const saved = fileContent;
	pressCanvas(view, 'ArrowRight');
	await clickCanvasMenu(view, 'Export SVG');
	const exported = fileContent;
	assert.equal(view.domNode.classList.contains('dirty'), true);
	const svg = new browser.window.DOMParser().parseFromString(exported, 'image/svg+xml');
	assert.equal(svg.querySelector('parsererror'), null);
	assert.equal(svg.querySelector('script'), null);
	assert.equal(svg.querySelector('[data-shape-id]'), null);
	assert.equal(svg.querySelector('.ash-sessions-design-selection'), null);
	assert.equal(svg.querySelector('text')!.textContent, '中文 <script>alert(1)</script>Second line');
	assert.match(svg.querySelector('path')!.getAttribute('d')!, / Z$/u);
	fileContent = saved;
	await clickCanvasMenu(view, 'Open design');
	pressCanvas(view, 'Tab');
	pressCanvas(view, 'u');
	assert.equal(view.domNode.querySelectorAll('.ash-sessions-design-shapes > [data-shape-id]').length, 2);
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(view.domNode.querySelectorAll('.ash-sessions-design-shapes > [data-shape-id]').length, 1);
});

test('Design property sections follow the selected object and path stroke edits share undo history', () => {
	using view = createView();
	const sections = (): string[] => [...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent!);
	pressCanvas(view, 'r');
	assert.deepEqual(sections(), ['Position', 'Layout', 'Appearance']);
	const position = view.propertiesDomNode.querySelector<HTMLDetailsElement>('details')!;
	position.open = false;
	pressCanvas(view, 't');
	assert.deepEqual(sections(), ['Position', 'Layout', 'Appearance', 'Typography']);
	assert.equal(position.open, false);
	DesignEditorWidget.getFocused(view.domNode)!.focusProperties();
	assert.equal(position.open, true);
	assert.equal(browser.window.document.activeElement?.getAttribute('aria-label'), 'X');
	pressCanvas(view, 'p');
	assert.deepEqual(sections(), ['Position', 'Layout', 'Appearance', 'Bézier path']);
	const path = view.domNode.querySelector<SVGPathElement>('path[data-shape-id]')!;
	const original = path.getAttribute('stroke-width');
	const stroke = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Stroke width"]')!;
	stroke.value = '6.5';
	stroke.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(path.getAttribute('stroke-width'), '6.5');
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(path.getAttribute('stroke-width'), original);
	stroke.value = '0';
	stroke.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(path.getAttribute('stroke-width'), original);
	pressCanvas(view, 'f');
	assert.deepEqual(sections(), ['Position', 'Layout', 'Appearance']);
	assert.equal(view.propertiesDomNode.querySelector<HTMLElement>('.ash-design-frame-properties')!.hidden, false);
});

test('Design properties switch between Page, object and multiple selection while reusing export and fill history', async () => {
	using view = createView();
	const root = view.propertiesDomNode.querySelector<HTMLElement>('.ash-sessions-design-properties')!;
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	const heading = (): string => root.querySelector('h2')!.textContent!;
	const visibleSections = (): string[] => [...root.querySelectorAll<HTMLDetailsElement>('details')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent!);
	const exportButton = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Export design')!;
	assert.deepEqual({ heading: heading(), sections: visibleSections(), visible: root.classList.contains('visible'), exportDisabled: exportButton.disabled }, { heading: 'Page', sections: [], visible: true, exportDisabled: true });
	pressCanvas(view, 'r');
	const rectangle = editor.documentController.model.value.shapes[0];
	const opacity = root.querySelector<HTMLInputElement>('input[aria-label="Fill opacity (%)"]')!;
	opacity.value = '50'; opacity.dispatchEvent(new browser.window.Event('change'));
	assert.equal(editor.documentController.model.value.shapes[0].fill, '#80808080');
	editor.undo();
	assert.equal(editor.documentController.model.value.shapes[0].fill, rectangle.fill);
	pressCanvas(view, 'e');
	editor.selectShapes(editor.documentController.model.value.shapes.map(shape => shape.id));
	assert.deepEqual({ heading: heading(), sections: visibleSections(), exportDisabled: exportButton.disabled }, { heading: '2 objects selected.', sections: [], exportDisabled: false });
	editor.selectShapes([]);
	assert.equal(heading(), 'Page');
	const exportFormat = root.querySelector<HTMLSelectElement>('select[aria-label="Export format"]')!;
	const beforeExport = editor.documentController.model.value;
	for (const format of ['svg', 'html']) {
		exportFormat.value = format;
		const completed = new Promise<void>(resolve => {
			const listener = editor.documentController.onDidChange(() => { if (!editor.documentController.isBusy) { listener.dispose(); resolve(); } });
		});
		exportButton.click();
		await completed;
		assert.match(writes.at(-1)!.content, format === 'svg' ? /^<svg/u : /^<!doctype html>/iu);
		assert.equal(editor.documentController.model.value, beforeExport);
	}
});

test('Chinese Design actions and new property labels are localized', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		pressCanvas(view, 't');
		assert.equal(view.propertiesDomNode.querySelector('.ash-sessions-design-properties textarea')!.getAttribute('aria-label'), '文字内容');
		assert.deepEqual([...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent), ['位置', '布局', '外观', '文字排版']);
		pressCanvas(view, 'p');
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="出控制点 X"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="描边宽度"]'));
		pressCanvas(view, 'F10', { shiftKey: true });
		assert.ok(contextMenu!.getActions().some(action => action.label === '导出 SVG'));
		assert.equal(chinese.bundles.ash['sessions.design.contextMenuHelp'].includes('Shift+F10'), true);
		pressCanvas(view, 'n');
		pressCanvas(view, 'g');
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /组合[\s\S]*文字[\s\S]*贝塞尔路径/u);
	} finally { resetNlsResolver(); }
});

test('Design editors share document edits and history while keeping selection, camera and lifetime separate', () => {
	using document = services.createInstance(DesignDocumentController, CreatorMode.Design);
	using first = services.createInstance(DesignEditorWidget, browser.window.document, document, (context: DesignEditorContributionContext) => createDesignEditorContributions(context, services));
	using second = services.createInstance(DesignEditorWidget, browser.window.document, document, (context: DesignEditorContributionContext) => createDesignEditorContributions(context, services));
	for (const editor of [first, second]) {
		editor.initialize();
		editor.layout({ width: 400, height: 300 });
		browser.window.document.body.append(editor.domNode);
	}
	pressCanvas(first, 'r');
	assert.equal(second.domNode.querySelectorAll('[data-shape-id]').length, 1);
	assert.match(first.getAccessibleContent(), /Selected/u);
	assert.doesNotMatch(second.getAccessibleContent(), /Selected/u);
	pressCanvas(second, 'ArrowRight');
	assert.deepEqual(projectedTransform(first), { panX: 0, panY: 0, scale: 1 });
	assert.deepEqual(projectedTransform(second), { panX: -60, panY: 0, scale: 1 });
	pressCanvas(second, 'Tab');
	pressCanvas(second, 'ArrowRight');
	assert.equal(first.domNode.querySelector('[data-shape-id]')!.getAttribute('x'), '141');
	first.undo();
	assert.equal(second.domNode.querySelector('[data-shape-id]')!.getAttribute('x'), '140');
	first.undo();
	assert.equal(second.domNode.querySelectorAll('[data-shape-id]').length, 0);
	second.redo();
	assert.equal(first.domNode.querySelectorAll('[data-shape-id]').length, 1);
	first.dispose();
	assert.equal(DesignEditorWidget.getFocused(first.domNode), undefined);
	pressCanvas(second, 'e');
	assert.equal(document.model.value.shapes.length, 2);
	assert.equal(first.domNode.querySelector('.ash-canvas-viewport'), null);
});

test('Design editor owns the unsaved browser-close check and releases it with the editor', () => {
	const page = createView();
	try {
		pressCanvas(page, 'r');
		const before = new browser.window.Event('beforeunload', { cancelable: true });
		browser.window.dispatchEvent(before);
		assert.equal(before.defaultPrevented, true);
		page.dispose();
		const after = new browser.window.Event('beforeunload', { cancelable: true });
		browser.window.dispatchEvent(after);
		assert.equal(after.defaultPrevented, false);
		assert.equal(DesignEditorWidget.getFocused(page.domNode), undefined);
	} finally { page.dispose(); }
});

test('Design tool contribution draws a shape at document coordinates and hand gestures preserve objects', async () => {
	using view = createView();
	view.layout({ width: 400, height: 300 });
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	const pointer = (type: string, x: number, y: number): void => {
		viewport.dispatchEvent(new browser.window.PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
	};
	const tools = view.domNode.querySelector('.ash-design-tools-widget')!;
	tools.querySelector<HTMLButtonElement>('button[aria-label="Rectangle"]')!.click();
	pointer('pointerdown', 40, 30);
	pointer('pointermove', 180, 90);
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 0);
	pointer('pointerup', 180, 90);
	const rectangle = view.domNode.querySelector('[data-shape-id]')!;
	assert.deepEqual(['x', 'y', 'width', 'height'].map(field => rectangle.getAttribute(field)), ['40', '30', '140', '60']);
	tools.querySelector<HTMLButtonElement>('button[aria-label="Selection tools"]')!.click();
	await contextMenu!.getActions().find(action => action.label === 'Move canvas (H)')!.run();
	contextMenu!.onHide!(false);
	pointer('pointerdown', 100, 60);
	pointer('pointermove', 120, 70);
	pointer('pointerup', 120, 70);
	assert.deepEqual(projectedTransform(view), { panX: 20, panY: 10, scale: 1 });
	assert.equal(rectangle.getAttribute('x'), '40');
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(view.domNode.querySelector('[data-shape-id]'), null);
	await clickAction(view, 'Draw');
	pointer('pointerdown', 30, 20);
	pointer('pointermove', 40, 30);
	pointer('pointermove', 60, 20);
	pointer('pointerup', 60, 20);
	assert.equal(view.domNode.querySelector('path[data-shape-id]') !== null, true);
	await clickAction(view, 'Design');
	tools.querySelector<HTMLButtonElement>('button[aria-label="Pen (P)"]')!.click();
	pointer('pointerdown', 100, 20); pointer('pointerup', 100, 20);
	pointer('pointerdown', 160, 80); pointer('pointermove', 180, 90); pointer('pointerup', 180, 90);
	pressCanvas(view, 'Enter');
	assert.equal(view.domNode.querySelectorAll('path[data-shape-id]').length, 2);
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(view.domNode.querySelectorAll('path[data-shape-id]').length, 1);
});

test('Registered Design tools and modes act on the originating editor and preserve grouped choices', async () => {
	using first = createView();
	using second = createView();
	const editor = DesignEditorWidget.getFocused(first.domNode)!;
	await commandService.executeCommand('sessions.design.tool.ellipse', editor);
	await clickAction(first, 'Pen (P)');
	await clickAction(first, 'Ellipse');
	assert.equal(first.domNode.querySelector('button[aria-label="Ellipse"]')!.getAttribute('aria-pressed'), 'true');
	await commandService.executeCommand('sessions.design.mode.code', editor);
	assert.deepEqual([first.domNode.classList.contains('code-mode'), second.domNode.classList.contains('code-mode')], [true, false]);
	assert.ok(first.domNode.querySelector('button[aria-label="Shape tools"]')!.hasAttribute('disabled'));
	await clickAction(first, 'Design');
	const trigger = first.domNode.querySelector<HTMLButtonElement>('button[aria-label="Shape tools"]')!;
	trigger.click();
	assert.deepEqual(contextMenu!.getActions().map(action => action.label), ['Rectangle', 'Ellipse']);
	assert.equal(contextMenu!.getMenuClassName!(), 'ash-design-menu');
	contextMenu!.onHide!(true);
});

test('Motion keyframes round trip, scrub without editing, undo and export runnable code with design identities', async () => {
	using view = createView();
	view.layout({ width: 400, height: 300 });
	pressCanvas(view, 'r');
	const id = view.domNode.querySelector<SVGGraphicsElement>('[data-shape-id]')!.dataset.shapeId;
	await clickAction(view, 'Motion');
	await clickAction(view, 'Add keyframe');
	const x = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Keyframe X"]')!;
	x.value = '240';
	x.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	const opacity = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Keyframe opacity"]')!;
	opacity.value = '0.5'; opacity.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	const timeline = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Animation time (ms)"]')!;
	timeline.value = '500'; timeline.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
	const rectangle = view.domNode.querySelector<SVGGraphicsElement>('[data-shape-id]')!;
	assert.deepEqual([rectangle.getAttribute('x'), rectangle.getAttribute('opacity')], ['190', '0.75']);
	assert.equal(view.domNode.querySelector('.ash-canvas-selection rect')!.getAttribute('x'), '190');
	assert.equal(view.domNode.querySelector('.ash-sessions-design-selection')!.classList.contains('visible'), true);
	await clickAction(view, 'Add keyframe');
	assert.equal(view.domNode.querySelector<HTMLSelectElement>('select[aria-label="Keyframe"]')!.options.length, 3);
	await DesignEditorWidget.getFocused(view.domNode)!.saveDocument();
	const saved = fileContent;
	assert.equal(parseDesignDocument(saved).shapes[0].motion!.keyframes.length, 3);
	timeline.value = '750'; timeline.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
	assert.equal(view.domNode.classList.contains('dirty'), false);
	await clickAction(view, 'Code');
	const source = view.domNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="Generated code"]')!.value;
	assert.match(source, /@keyframes[\s\S]*opacity: 0\.5/u);
	const html = new browser.window.DOMParser().parseFromString(source, 'text/html');
	assert.equal(html.querySelector('[data-design-id]')!.getAttribute('data-design-id'), id);
	assert.deepEqual(JSON.parse(html.querySelector('#ash-design-document')!.textContent!), JSON.parse(saved));
	assert.equal(html.querySelectorAll('script:not([type="application/json"])').length, 0);
	await clickAction(view, 'Export code');
	assert.equal(fileContent, source);
	assert.equal(view.domNode.classList.contains('dirty'), false);
	fileContent = saved;
	await clickCanvasMenu(view, 'Open design');
	await clickAction(view, 'Design');
	assert.equal(rectangle.getAttribute('x'), '140');
	pressCanvas(view, 'Tab');
	await clickAction(view, 'Motion');
	assert.equal(view.domNode.querySelector<HTMLSelectElement>('select[aria-label="Keyframe"]')!.options.length, 3);
	await clickAction(view, 'Remove animation');
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(view.domNode.querySelector<HTMLSelectElement>('select[aria-label="Keyframe"]')!.options.length, 3);
});

test('Code contribution escapes user text and Chinese tool, mode and timeline names are translated', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		assert.ok(view.domNode.querySelector('button[aria-label="选择工具"]'));
		assert.ok(view.domNode.querySelector('button[aria-label="形状工具"]'));
		pressCanvas(view, 't');
		const text = view.propertiesDomNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="文字内容"]')!;
		text.value = '</script><script>alert(1)</script> 中文';
		text.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
		await clickAction(view, '动效');
		await clickAction(view, '添加关键帧');
		assert.ok(view.domNode.querySelector('input[aria-label="关键帧透明度"]'));
		await clickAction(view, '代码');
		const source = view.domNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="生成的代码"]')!.value;
		const html = new browser.window.DOMParser().parseFromString(source, 'text/html');
		assert.equal(html.querySelectorAll('script').length, 1);
		assert.deepEqual(parseDesignDocument(html.querySelector('script')!.textContent!).shapes.map(shape => shape.kind === 'text' ? shape.text : undefined), [text.value]);
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /doctype html/u);
	} finally { resetNlsResolver(); }
});


test('Design panels share the editor selection and detach when the pane hides', () => {
	using view = createView();
	pressCanvas(view, 'r');
	pressCanvas(view, 'e');
	assert.equal(view.domNode.querySelector('.ash-sessions-design-properties'), null);
	assert.equal(view.layersDomNode.querySelectorAll('[role="treeitem"]').length, 2);
	const rectangle = [...view.layersDomNode.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(element => element.textContent?.includes('Rectangle'))!;
	rectangle.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
	assert.deepEqual([...view.designEditors.activeEditor.get()!.selection.ids], [view.pane.workingCopy.model.value.shapes[0]!.id]);
	const ellipse = [...view.layersDomNode.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(element => element.textContent?.includes('Ellipse'))!;
	ellipse.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
	assert.equal(view.designEditors.activeEditor.get()!.selection.ids.size, 2);
	assert.equal(view.propertiesDomNode.querySelector('.ash-sessions-design-properties')!.classList.contains('visible'), true);
	assert.equal(view.propertiesDomNode.querySelector('.ash-design-properties-heading')!.textContent, '2 objects selected.');
	rectangle.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
	assert.equal(view.propertiesDomNode.querySelector('.ash-sessions-design-properties')!.classList.contains('visible'), true);
	view.pane.setVisible(false);
	assert.equal(view.designEditors.activeEditor.get(), undefined);
	assert.equal(view.propertiesDomNode.querySelector('.ash-sessions-design-properties'), null);
	assert.equal(view.layersDomNode.querySelectorAll('[role="treeitem"]').length, 0);
	view.pane.setVisible(true);
	assert.equal(view.layersDomNode.querySelectorAll('[role="treeitem"]').length, 2);
	assert.equal(view.propertiesDomNode.querySelector('.ash-sessions-design-properties')!.classList.contains('visible'), true);
});

test('Design shutdown checks cancel, save and discard even while its page is hidden', async () => {
	using child = services.createChild();
	using shutdown = new Emitter<IBeforeShutdownEvent>();
	child.registerInstance(ILifecycleService, { ...services.get(ILifecycleService), onBeforeShutdown: shutdown.event });
	using designEditors = child.createInstance(DesignEditorService);
	child.registerInstance(IDesignEditorService, designEditors);
	using page = child.createInstance(DesignEditorPage, CreatorMode.Design);
	const host = browser.window.document.createElement('section');
	browser.window.document.body.append(host);
	using hostCleanup = toDisposable(() => host.remove());
	page.create(host);
	page.setVisible(true);
	const editor = designEditors.activeEditor.get()!;
	const isVetoed = async (): Promise<boolean> => {
		const vetoes: (boolean | Promise<boolean>)[] = [];
		shutdown.fire({ reason: 'windowClose', veto: value => { vetoes.push(value); } });
		return (await Promise.all(vetoes)).some(Boolean);
	};
	try {
		pressCanvas(editor, 'r');
		page.setVisible(false);
		saveDecision = ConfirmResult.CANCEL;
		assert.equal(await isVetoed(), true);
		assert.equal(designEditors.document.isDirty, true);
		saveDecision = ConfirmResult.SAVE;
		assert.equal(await isVetoed(), false);
		assert.equal(parseDesignDocument(fileContent).shapes.length, 1);
		assert.equal(designEditors.document.isDirty, false);
		assert.equal(designEditors.activeEditor.get(), undefined);
		page.setVisible(true);
		pressCanvas(editor, 'e');
		saveDecision = ConfirmResult.DONT_SAVE;
		assert.equal(await isVetoed(), false);
		assert.equal(services.get(IWorkingCopyService).get(DESIGN_EDITOR_RESOURCE).length, 1);
	} finally { saveDecision = ConfirmResult.DONT_SAVE; }
});

test('Design panel labels and empty states follow Chinese localization', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		assert.equal(view.layersDomNode.querySelector('[role="tree"]')!.getAttribute('aria-label'), '图层');
		assert.match(view.layersDomNode.textContent!, /绘制对象后会显示对应图层。/u);
		assert.equal(view.propertiesDomNode.querySelector('.ash-design-properties-heading')!.textContent, '页面');
		assert.equal(view.propertiesDomNode.querySelector('.ash-design-page-summary')!.textContent, '0 个对象');
		assert.ok(view.propertiesDomNode.querySelector('select[aria-label="导出格式"]'));
		assert.match(view.propertiesDomNode.textContent!, /网格 · 12 像素/u);
	} finally { resetNlsResolver(); }
});


test('Design page instances share the window document and retain independent editing state', async () => {
	using child = services.createChild();
	using designEditors = child.createInstance(DesignEditorService);
	child.registerInstance(IDesignEditorService, designEditors);
	using firstPage = child.createInstance(DesignEditorPage, CreatorMode.Design);
	using secondPage = child.createInstance(DesignEditorPage, CreatorMode.Design);
	const host = browser.window.document.createElement('section');
	browser.window.document.body.append(host);
	using hostCleanup = toDisposable(() => host.remove());
	firstPage.create(host);
	firstPage.setVisible(true);
	const first = designEditors.activeEditor.get()!;
	pressCanvas(first, 'r');
	pressCanvas(first, '+');
	secondPage.create(host);
	secondPage.setVisible(true);
	const second = designEditors.activeEditor.get()!;
	assert.notEqual(first, second);
	assert.equal(first.documentController, second.documentController);
	assert.equal(services.get(IWorkingCopyService).get(DESIGN_EDITOR_RESOURCE).length, 1);
	assert.equal(second.domNode.querySelectorAll('[data-shape-id]').length, 1);
	assert.equal(second.selection.ids.size, 0);
	assert.equal(projectedTransform(first).scale, 1.2);
	assert.equal(projectedTransform(second).scale, 1);
	pressCanvas(second, 'e');
	assert.equal(first.documentController.model.value.shapes.length, 2);
	first.focus();
	assert.equal(designEditors.activeEditor.get(), first);
	assert.equal(first.selection.ids.size, 1);
});

test('Frame image properties, package media, backup recovery and SVG export keep one editable document', async () => {
	using view = createView();
	const controller = view.pane.workingCopy;
	const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const asset = { id: generateUuid(), name: 'product.png', versions: [{ id: generateUuid(), sha256, path: `assets/${sha256}`, mediaType: 'image/png' as const, width: 1, height: 1 }] };
	const image = { id: generateUuid(), kind: 'image' as const, assetId: asset.id, assetVersionId: asset.versions[0].id, crop: { x: 0, y: 0, width: 1, height: 1 }, x: 20, y: 30, width: 200, height: 100, rotation: 0, fill: '#ffffff' };
	const frame = { id: generateUuid(), kind: 'frame' as const, clip: true, children: [image], x: 100, y: 200, width: 640, height: 480, rotation: 0, fill: '#ffffff' };
	controller.restoreBackup(JSON.stringify({ manifest: serializeDesignDocument(documentFromShapes([frame], undefined, [asset])), media: { [sha256]: Buffer.from(bytes).toString('base64') } }));
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	editor.selectShape(image.id);
	assert.deepEqual([...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent), ['Position', 'Layout', 'Image crop']);
	const crop = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Crop width (%)"]')!;
	crop.value = '50'; crop.dispatchEvent(new browser.window.Event('change'));
	assert.equal(view.domNode.querySelector('svg[data-shape-id] svg[data-shape-id]')!.getAttribute('viewBox'), '0 0 0.5 1');
	pressCanvas(view, 'ArrowRight');
	assert.equal((controller.model.value.shapes[0] as typeof frame).children[0].x, 21);
	editor.selectShape(frame.id);
	const width = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
	width.value = '800'; width.dispatchEvent(new browser.window.Event('change'));
	assert.equal((controller.model.value.shapes[0] as typeof frame).children[0].width, 200);
	const beforeSave = controller.model.value;
	fileContent = ''; revision = '0'; errors = []; binaryFiles.clear();
	assert.equal(await editor.saveDocument(), true);
	assert.deepEqual(binaryFiles.get(URI.joinPath(resource, `assets/${sha256}`).toString()), bytes);
	assert.equal(writes.at(-1)!.resource.path, '/design.ash-design/manifest.json');
	assert.deepEqual(parseDesignDocument(fileContent), beforeSave);
	assert.equal(controller.isDirty, false);
	const backup = controller.backup();
	using recovered = services.createInstance(DesignDocumentController, CreatorMode.Design);
	recovered.restoreBackup(backup);
	assert.deepEqual(recovered.readMedia(asset.versions[0]), bytes);
	assert.deepEqual(recovered.model.value, beforeSave);
	assert.equal(recovered.isDirty, true);
	await clickCanvasMenu(view, 'Export SVG');
	assert.match(fileContent, /href="data:image\/png;base64,/u);
	assert.equal(controller.isDirty, false);
	fileContent = serializeDesignDocument(beforeSave);
	await controller.openDocument();
	assert.deepEqual(controller.model.value, beforeSave);
	assert.equal(controller.model.canUndo, false);
	const active = controller.model.value;
	binaryFiles.set(URI.joinPath(resource, `assets/${sha256}`).toString(), new Uint8Array([1, 2, 3]));
	await controller.openDocument();
	assert.equal(controller.model.value, active);
	assert.equal(errors.length, 1);
	assert.equal(errors[0], 'Could not open the design.');
	assert.throws(() => recovered.restoreBackup(JSON.stringify({ manifest: serializeDesignDocument(beforeSave), media: {} })), /Missing design backup media/u);
	assert.equal(recovered.model.value.documentId, beforeSave.documentId);
});

test('Frame rotation keeps keyboard movement in canvas directions and unclipped exports retain overflow', async () => {
	using view = createView();
	const controller = view.pane.workingCopy;
	const child = { id: generateUuid(), kind: 'rectangle' as const, x: 20, y: 30, width: 50, height: 40, rotation: 0, fill: '#ffffff' };
	const frame = { id: generateUuid(), kind: 'frame' as const, clip: false, children: [child], x: 100, y: 200, width: 100, height: 100, rotation: 90, fill: '#ffffff' };
	controller.model.replace(documentFromShapes([frame]));
	DesignEditorWidget.getFocused(view.domNode)!.selectShape(child.id);
	pressCanvas(view, 'ArrowRight');
	const updated = controller.model.value.shapes[0];
	assert.equal(updated.kind, 'frame');
	if (updated.kind !== 'frame') { throw new Error('Expected frame'); }
	assert.equal(updated.children[0].x, 20);
	assert.equal(updated.children[0].y, 29);
	const { exportDesignSvg } = await import('../../contrib/creator/browser/svgRenderer.js');
	const overflowing = { ...frame, rotation: 0, children: [{ ...child, x: -50, y: -20 }] };
	assert.match(exportDesignSvg(documentFromShapes([overflowing])), /viewBox="50 180 150 120"/u);
	assert.match(exportDesignSvg(documentFromShapes([{ ...overflowing, clip: true }])), /viewBox="100 200 100 100"/u);
	const { generateDesignCode } = await import('../../contrib/creator/contrib/code/browser/designCodeGenerator.js');
	const motion = { duration: 1000, loop: false, keyframes: [{ offset: 0, x: -50, y: -20, rotation: 0, opacity: 1 }, { offset: 1, x: 40, y: -20, rotation: 0, opacity: 1 }] };
	const code = generateDesignCode(documentFromShapes([{ ...overflowing, children: [{ ...overflowing.children[0], motion }] }]));
	assert.match(code, new RegExp(`@keyframes ash-design-object-${child.id}-motion`, 'u'));
	assert.match(code, /overflow: visible/u);
});

test('Saving captures a baseline while later edits and Save As retain dirty state and history', async () => {
	fileContent = ''; revision = '0';
	const files = services.get(IFileService);
	let release: (() => void) | undefined;
	let entered: (() => void) | undefined;
	const writing = new Promise<void>(resolve => { entered = resolve; });
	const pending = new Promise<void>(resolve => { release = resolve; });
	using childServices = services.createChild();
	childServices.registerSingleton(IFileService, () => createTestFileService({
		...fileProvider, writeFile: async (resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> => {
			const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
			entered!(); await pending; return files.writeFile(request);
		},
	}));
	using controller = childServices.createInstance(DesignDocumentController, CreatorMode.Design);
	const shape = { id: generateUuid(), kind: 'rectangle' as const, x: 0, y: 0, width: 50, height: 40, rotation: 0, fill: '#ffffff' };
	controller.model.applyEdit([shape]);
	const saving = controller.saveDocument();
	await writing;
	controller.model.applyEdit([{ ...shape, x: 20 }]);
	release!();
	assert.equal(await saving, false);
	assert.equal(parseDesignDocument(fileContent).shapes[0].x, 0);
	assert.equal(controller.isDirty, true);
	controller.model.undo();
	assert.equal(controller.isDirty, false);
	controller.model.redo();
	const originalIdentity = controller.model.value.documentId;
	assert.equal(await controller.saveDocument(URI.file('/copy.ash-design')), true);
	const copied = parseDesignDocument(fileContent);
	assert.notEqual(copied.documentId, originalIdentity);
	controller.model.undo();
	assert.equal(controller.model.value.documentId, copied.documentId);
	assert.equal(controller.model.value.shapes[0].x, 0);
	assert.equal(controller.isDirty, true);
});

test('Chinese frame and image controls use translated labels and accessible descriptions', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		pressCanvas(view, 'f');
		assert.equal(view.domNode.querySelector('button[aria-label="添加画板 (F)"]') !== null, true);
		assert.equal(view.domNode.querySelector('button[aria-label="导入图片"]') !== null, true);
		assert.equal(view.propertiesDomNode.querySelector('input[aria-label="裁切画板内容"]') !== null, true);
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /画板/u);
		assert.match(chinese.bundles.ash['sessions.design.mediaHelp'], /原图保持完整/u);
	} finally { resetNlsResolver(); }
});


test('Design import adopts backend version identities and metadata and packages backend content', async () => {
	using child = services.createChild();
	const source = URI.file('/product.png');
	const original = new Uint8Array([1, 2, 3]);
	const committed = new Uint8Array([4, 5, 6]);
	const backend = { assetId: generateUuid(), versionId: generateUuid(), name: 'Library product', source, sha256: createHash('sha256').update(committed).digest('hex'), mediaType: 'image/png' as const, size: committed.length, width: 320, height: 200 };
	child.registerInstance(IFileDialogService, { ...services.get(IFileDialogService), showOpenDialog: async () => [source] });
	child.registerSingleton(IFileService, () => createTestFileService({
		...fileProvider, readFile: async () => ({ resource: source, bytes: original, revision: '1' })
	}));
	let imports = 0;
	child.registerInstance(IAssetService, {
		getCatalog: unexpected, updateEntry: unexpected, createCollection: unexpected, deleteCollection: unexpected,
		importImage: async request => { imports++; assert.deepEqual(request.bytes, original); assert.equal(request.source.toString(), source.toString()); return backend; },
		getVersion: unexpected,
		readVersion: async version => { assert.equal(version, backend); return committed; },
	});
	using controller = child.createInstance(DesignDocumentController, CreatorMode.Design);
	const id = await controller.importImage({ x: 500, y: 400 });
	assert.ok(id);
	assert.equal(imports, 1);
	const asset = controller.model.value.assets[0];
	assert.equal(asset.id, backend.assetId);
	assert.equal(asset.name, backend.name);
	assert.deepEqual(asset.versions[0], { id: backend.versionId, mediaType: backend.mediaType, width: 320, height: 200, sha256: backend.sha256, path: `assets/${backend.sha256}` });
	assert.deepEqual(controller.readMedia(asset.versions[0]), committed);
	assert.equal(controller.model.value.shapes.find(shape => shape.id === id)!.width, 320);
});


test('Design reuses the exact Library version without importing again or duplicating its asset entry', async () => {
	using child = services.createChild();
	const bytes = new Uint8Array([1, 2, 3]);
	const version = { assetId: generateUuid(), versionId: generateUuid(), name: 'Library image', source: URI.file('/image.png'), sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' as const, size: bytes.length, width: 100, height: 60 };
	child.registerInstance(IAssetService, { getCatalog: unexpected, updateEntry: unexpected, createCollection: unexpected, deleteCollection: unexpected, importImage: unexpected, getVersion: unexpected, readVersion: async selected => { assert.equal(selected, version); return bytes; } });
	using controller = child.createInstance(DesignDocumentController, CreatorMode.Design);
	await controller.adoptAssetVersion(version, { x: 200, y: 200 });
	await controller.adoptAssetVersion(version, { x: 400, y: 400 });
	assert.equal(controller.model.value.assets.length, 1);
	assert.equal(controller.model.value.assets[0].versions.length, 1);
	assert.deepEqual(controller.model.value.shapes.map(shape => shape.kind === 'image' ? [shape.assetId, shape.assetVersionId] : undefined), [[version.assetId, version.versionId], [version.assetId, version.versionId]]);
	assert.deepEqual(controller.readMedia(controller.model.value.assets[0].versions[0]), bytes);
	controller.model.undo();
	assert.equal(controller.model.value.shapes.length, 1);
});

class CreatorFixture extends Disposable {
	readonly page: InstanceType<typeof CreatorPage>;
	readonly editors: InstanceType<typeof DesignEditorService>;
	constructor() {
		super();
		setARIAContainer(browser.window.document.body);
		const child = this._register(services.createChild());
		this.editors = this._register(child.createInstance(DesignEditorService));
		child.registerInstance(IDesignEditorService, this.editors);
		child.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Press Alt+F1 for help.', show: () => { throw new Error('Unexpected accessible view'); }, disableHint: unexpected, showAccessibleViewHelp: () => { throw new Error('Unexpected accessible view'); }, dispose() { }, [Symbol.dispose]() { } });
		const storage = this._register(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: generateUuid(), flushInterval: 0 }));
		child.registerInstance(IStorageService, storage);
		this.page = this._register(child.createInstance(CreatorPage, browser.window.document));
		browser.window.document.body.append(this.page.domNode);
		this.page.initialize();
		this.page.layout({ width: 1000, height: 720 });
		this.page.setVisible(true);
	}
	click(label: string): void {
		const button = [...this.page.domNode.querySelectorAll<HTMLElement>('button, [role="button"]')].find(element => element.getAttribute('aria-label') === label && !element.closest('[hidden]'));
		assert.ok(button, label);
		button.click();
	}
}

test('Creator routes all seven contributions and retains separate documents, selection and camera', () => {
	using fixture = new CreatorFixture();
	assert.equal(fixture.page.domNode.querySelectorAll('[data-creator-mode]').length, 7);
	assert.equal(fixture.page.usesCanvasPanels, false);
	fixture.page.openMode(CreatorMode.Design);
	const design = fixture.editors.activeEditor.get()!;
	pressCanvas(design, 'r');
	pressCanvas(design, '+');
	const selected = [...design.selection.ids];
	const transform = projectedTransform(design);
	fixture.page.showHome();
	assert.equal(fixture.editors.activeEditor.get(), undefined);
	assert.equal(fixture.page.domNode.ownerDocument.activeElement?.getAttribute('data-creator-mode'), 'design');
	fixture.page.openMode(CreatorMode.Whiteboard);
	fixture.click('Add note');
	const whiteboard = fixture.editors.getDocument(CreatorMode.Whiteboard);
	assert.equal(whiteboard.model.value.shapes[0].kind, 'group');
	whiteboard.model.undo();
	assert.equal(whiteboard.model.value.shapes.length, 0);
	assert.equal(design.documentController.model.value.shapes.length, 1);
	for (const mode of [CreatorMode.Slides, CreatorMode.Brand, CreatorMode.Sites, CreatorMode.Make, CreatorMode.Prototype]) {
		fixture.page.openMode(mode);
		assert.equal(fixture.editors.activeEditor.get()!.documentController.model.value.mode, mode);
		assert.equal(fixture.editors.getDocument(mode).model.value.shapes.length, 0);
		assert.equal(fixture.page.usesCanvasPanels, mode !== CreatorMode.Make);
	}
	fixture.page.openMode(CreatorMode.Design);
	assert.equal(fixture.editors.activeEditor.get(), design);
	assert.deepEqual([...design.selection.ids], selected);
	assert.deepEqual(projectedTransform(design), transform);
	fixture.page.setVisible(false);
	assert.equal(fixture.editors.activeEditor.get(), undefined);
	fixture.page.setVisible(true);
	assert.equal(fixture.editors.activeEditor.get(), design);
});

test('Creator Slides order and Brand variants use their own complete undo history', () => {
	using fixture = new CreatorFixture();
	fixture.page.openMode(CreatorMode.Slides);
	fixture.click('Add slide');
	fixture.click('Add slide');
	const slides = fixture.editors.getDocument(CreatorMode.Slides).model;
	const order = slides.value.shapes.map(shape => shape.id);
	assert.deepEqual(slides.value.shapes.map(shape => [shape.width, shape.height]), [[1280, 720], [1280, 720]]);
	fixture.click('Move slide earlier');
	assert.deepEqual(slides.value.shapes.map(shape => shape.id), [...order].reverse());
	slides.undo();
	assert.deepEqual(slides.value.shapes.map(shape => shape.id), order);
	fixture.page.openMode(CreatorMode.Brand);
	fixture.click('Square asset');
	fixture.click('Create size variants');
	const brand = fixture.editors.getDocument(CreatorMode.Brand).model;
	assert.deepEqual(brand.value.shapes.map(shape => [shape.width, shape.height]), [[1080, 1080], [1080, 1080], [1080, 1920], [1200, 628]]);
	assert.equal(parseDesignDocument(serializeDesignDocument(brand.value)).mode, CreatorMode.Brand);
	brand.undo();
	assert.equal(brand.value.shapes.length, 1);
	assert.equal(slides.value.shapes.length, 2);
});

test('Creator saves workspace identity and refuses to replace another mode with its file or backup', async () => {
	using controller = services.createInstance(DesignDocumentController, CreatorMode.Slides);
	new (await import('../../contrib/creator/common/commands/documentCommands.js')).DocumentCommands(controller.model).addFrame({ x: 0, y: 0 });
	assert.equal(await controller.saveDocument(), true);
	assert.equal(parseDesignDocument(fileContent).mode, CreatorMode.Slides);
	using other = services.createInstance(DesignDocumentController, CreatorMode.Design);
	const before = other.model.value;
	await other.openDocument();
	assert.equal(other.model.value, before);
	assert.throws(() => other.restoreBackup(controller.backup()), /belongs to Slides/);
	assert.equal(other.model.value, before);
});


test('Creator shutdown checks dirty documents in hidden modes', async () => {
	using child = services.createChild();
	using shutdown = new Emitter<IBeforeShutdownEvent>();
	child.registerInstance(ILifecycleService, { ...services.get(ILifecycleService), onBeforeShutdown: shutdown.event });
	using editors = child.createInstance(DesignEditorService);
	editors.getDocument(CreatorMode.Design);
	const slides = editors.getDocument(CreatorMode.Slides);
	const { DocumentCommands } = await import('../../contrib/creator/common/commands/documentCommands.js');
	new DocumentCommands(slides.model).addFrame({ x: 0, y: 0 });
	try {
		saveDecision = ConfirmResult.CANCEL;
		const vetoes: (boolean | Promise<boolean>)[] = [];
		shutdown.fire({ reason: 'windowClose', veto: value => { vetoes.push(value); } });
		assert.equal((await Promise.all(vetoes)).some(Boolean), true);
		assert.equal(slides.isDirty, true);
		assert.equal(editors.activeEditor.get(), undefined);
	} finally { saveDecision = ConfirmResult.DONT_SAVE; }
});
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
