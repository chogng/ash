import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { flattenDesignShapes, type DesignShape } from '../../contrib/creator/common/model/document.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { createTestFileService } from '../../../workbench/test/common/testEditorServices.js';
import { IAssetService } from '../../../platform/assets/common/assetService.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateUuid } from '../../../base/common/uuid.js';
import { Separator } from '../../../base/common/actions.js';
import { test, setup, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
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
import { TestWorkspaceService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { BrowserWorkingCopyService } from '../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService } from '../../../workbench/services/workingCopy/common/workingCopyService.js';

import { AbstractLifecycleService } from '../../../workbench/services/lifecycle/common/lifecycleService.js';
import { NullLoggerService } from '../../../platform/log/common/log.js';
import { ILifecycleService, LifecyclePhase, StartupKind, type IBeforeShutdownEvent } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { IUserDataProfileService } from '../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../workbench/services/userDataProfile/browser/userDataProfileService.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { setARIAContainer } from '../../../base/browser/ui/aria/aria.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
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
const notifications = new NotificationService();
services.registerInstance(INotificationService, notifications);
setup(() => notifications.clear());
suiteTeardown(() => notifications.dispose());
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
services.registerInstance(IWorkspaceContextService, new TestWorkspaceService({ id: 'design-test', folders: [] }));
const designStorage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: generateUuid(), flushInterval: 0 });
services.registerInstance(IStorageService, designStorage);
services.registerInstance(IUserDataProfileService, new UserDataProfileService());
setup(() => designStorage.remove('creator.design.activeDocument', StorageScope.WORKSPACE));
const resource = URI.file('/design.ash-design');
const binaryFiles = new Map<string, Uint8Array>();
const directories = new Set<string>();
let fileContent = '';
let revision = '0';
let errors: string[] = [];
let saveDecision = ConfirmResult.DONT_SAVE;
const writes: IFileWriteRequest[] = [];
const openedPrototypeLinks: string[] = [];
services.registerInstance(IOpenerService, { _serviceBrand: undefined, open: async target => { openedPrototypeLinks.push(target.toString()); return true; }, registerOpener: () => Disposable.None, registerValidator: () => Disposable.None, registerExternalUriResolver: () => Disposable.None, registerExternalOpener: () => Disposable.None, setDefaultExternalOpener: () => { }, resolveExternalUri: async resource => ({ ...Disposable.None, resolved: resource }) });
const unexpected = async (): Promise<never> => { throw new Error('Unexpected service call'); };
let contextMenu: IContextMenuDelegate | undefined;
services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom' as const,
	onDidShowContextMenu: AshEvent.None,
	onDidHideContextMenu: AshEvent.None,
	showContextMenu: delegate => {
		contextMenu?.onHide?.(true);
		contextMenu = delegate as IContextMenuDelegate;
	},
	hideContextMenu: () => { contextMenu?.onHide?.(true); contextMenu = undefined; },
});
services.registerInstance(IFileDialogService, {
	pickFolderAndOpen: async () => { throw new Error('Unexpected folder open'); },
	pickWorkspaceAndOpen: async () => { throw new Error('Unexpected workspace open'); },
	pickFileToSave: unexpected, showSaveConfirm: async () => saveDecision, showSaveDialog: async () => resource, showOpenDialog: async () => [resource]
});
services.registerInstance(IDialogService, { onWillShowDialog: AshEvent.None, onDidShowDialog: AshEvent.None, showMessage: unexpected, info: unexpected, warn: unexpected, error: async message => { errors.push(message); }, confirm: unexpected, prompt: unexpected, input: unexpected, about: unexpected });
services.registerInstance(IAssetService, { getCatalog: unexpected, updateEntry: unexpected, createCollection: unexpected, deleteCollection: unexpected, importImage: unexpected, getVersion: unexpected, readVersion: unexpected });
services.registerInstance(ISessionsLayoutService, { ...Disposable.None, conversationVisible: false, onDidChangeConversationVisibility: AshEvent.None, setConversationVisible: unexpected, openEntry: unexpected, restore: unexpected });
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
	designStorage.dispose();
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
		child.registerInstance(IStorageService, this._register(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: generateUuid(), flushInterval: 0 })));
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
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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

function createText(view: DesignEditorFixture): void {
	pressCanvas(view, 't');
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	for (const type of ['pointerdown', 'pointerup']) { viewport.dispatchEvent(new browser.window.PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 50, bubbles: true })); }
	view.domNode.querySelector('[contenteditable]')?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

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
			['Duplicate', false], ['Bring to front', false], ['Send to back', false], ['Add auto layout', false], ['Group', false], ['Create component', false], ['Detach instance', false], ['Ungroup', false], ['Add frame (F)', true], ['Import image', true], ['Export SVG', false], ['Open design', true], ['Save a copy', true],
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

test('Design saves before opening another file and rejects stale writes and invalid files', async () => {
	using view = createView();
	view.layout({ width: 200, height: 100 });
	errors = []; writes.length = 0; revision = '0';
	pressCanvas(view, 'r');
	await view.pane.editor.saveDocument();
	assert.equal(view.domNode.classList.contains('dirty'), false);
	pressCanvas(view, 'e');
	await clickCanvasMenu(view, 'Open design');
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 2);
	const saved = fileContent;
	pressCanvas(view, 'Tab'); pressCanvas(view, 'ArrowRight');
	revision = '99';
	await view.pane.editor.saveDocument();
	assert.equal(writes.at(-1)!.expectedRevision, '2');
	assert.equal(view.domNode.classList.contains('dirty'), true);
	assert.equal(fileContent, saved);
	assert.equal(errors.length, 1);
	await clickCanvasMenu(view, 'Open design');
	assert.equal(view.pane.workingCopy.needsSaveRetry, true);
	assert.equal(fileContent, saved);
	revision = '2';
	assert.equal(await view.pane.workingCopy.flushAutoSave(), true);
	fileContent = '{"version":1,"shapes":[{"kind":"rectangle"}]}';
	await clickCanvasMenu(view, 'Open design');
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 2);
	assert.equal(errors.length, 2);
});

test('Design keyboard selection and Chinese properties expose the document content', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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
	createText(view);
	const text = view.propertiesDomNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text content"]')!;
	text.value = '中文 <script>alert(1)</script>\nSecond line';
	text.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /中文 <script>/u);
	assert.equal(view.domNode.querySelector('script'), null);
	assert.equal(view.domNode.querySelectorAll('[data-text-paragraph]').length, 2);
	view.pane.editor.selectShape(new DocumentCommands(view.designEditors.document.model).addShape('path', { x: 200, y: 50 })); pressCanvas(view, 'Enter');
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
	assert.equal(svg.querySelector('parsererror')?.textContent, undefined);
	assert.equal(svg.querySelector('script'), null);
	assert.equal(svg.querySelector('[data-shape-id]'), null);
	assert.equal(svg.querySelector('.ash-sessions-design-selection'), null);
	assert.equal(svg.querySelector('[data-design-text]')!.textContent, '中文 <script>alert(1)</script>\nSecond line');
	assert.equal(svg.querySelector('[contenteditable]'), null);
	assert.match(svg.querySelector('path')!.getAttribute('d')!, / Z$/u);
	DesignEditorWidget.getFocused(view.domNode)!.undo();
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
	const sections = (): string[] => [...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details.ash-design-property-section')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent!);
	pressCanvas(view, 'r');
	assert.deepEqual(sections(), ['Components', 'Design resources', 'Layer', 'Arrange', 'Position', 'Layout', 'Appearance', 'Effects', 'Vector tools', 'Prototype']);
	const position = [...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details.ash-design-property-section')].find(section => section.querySelector('summary')?.textContent === 'Position')!;
	position.open = false;
	createText(view);
	assert.deepEqual(sections(), ['Components', 'Design resources', 'Layer', 'Arrange', 'Position', 'Layout', 'Appearance', 'Effects', 'Typography', 'Vector tools', 'Prototype']);
	assert.equal(position.open, false);
	DesignEditorWidget.getFocused(view.domNode)!.focusProperties();
	assert.equal(position.open, true);
	assert.equal(browser.window.document.activeElement?.getAttribute('aria-label'), 'X');
	view.pane.editor.selectShape(new DocumentCommands(view.designEditors.document.model).addShape('path', { x: 200, y: 50 })); pressCanvas(view, 'Enter');
	assert.deepEqual(sections(), ['Components', 'Design resources', 'Layer', 'Arrange', 'Position', 'Layout', 'Appearance', 'Effects', 'Bézier path', 'Vector tools', 'Prototype']);
	const path = view.domNode.querySelector<SVGPathElement>('path[data-shape-id]')!;
	const original = path.getAttribute('stroke-width');
	const stroke = view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="Stroke width"]')!;
	stroke.value = '6.5';
	stroke.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(path.getAttribute('stroke-width'), '6.5');
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(path.getAttribute('stroke-width'), original);
	stroke.value = '-1';
	stroke.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(path.getAttribute('stroke-width'), original);
	pressCanvas(view, 'f');
	assert.deepEqual(sections(), ['Components', 'Design resources', 'Layer', 'Arrange', 'Position', 'Layout', 'Appearance', 'Effects', 'Auto layout', 'Prototype']);
	assert.equal(view.propertiesDomNode.querySelector<HTMLElement>('.ash-design-frame-properties')!.hidden, false);
});

test('Design properties switch between Page, object and multiple selection while reusing export and fill history', async () => {
	using view = createView();
	const root = view.propertiesDomNode.querySelector<HTMLElement>('.ash-sessions-design-properties')!;
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	const heading = (): string => root.querySelector('h2')!.textContent!;
	const visibleSections = (): string[] => [...root.querySelectorAll<HTMLDetailsElement>('details.ash-design-property-section')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent!);
	const exportButton = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Export design')!;
	assert.deepEqual({ heading: heading(), sections: visibleSections(), visible: root.classList.contains('visible'), exportDisabled: exportButton.disabled }, { heading: 'Page', sections: ['Design resources', 'Prototype'], visible: true, exportDisabled: true });
	pressCanvas(view, 'r');
	const rectangle = editor.documentController.model.value.shapes[0];
	const opacity = root.querySelector<HTMLInputElement>('input[aria-label="Fill opacity (%)"]')!;
	opacity.value = '50'; opacity.dispatchEvent(new browser.window.Event('change'));
	assert.equal(editor.documentController.model.value.shapes[0].fill, '#80808080');
	editor.undo();
	assert.equal(editor.documentController.model.value.shapes[0].fill, rectangle.fill);
	pressCanvas(view, 'e');
	editor.selectShapes(editor.documentController.model.value.shapes.map(shape => shape.id));
	assert.deepEqual({ heading: heading(), sections: visibleSections(), exportDisabled: exportButton.disabled }, { heading: '2 objects selected.', sections: ['Components', 'Design resources', 'Arrange', 'Vector tools', 'Prototype'], exportDisabled: false });
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
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		createText(view);
		assert.equal(view.propertiesDomNode.querySelector('.ash-sessions-design-properties textarea')!.getAttribute('aria-label'), '文字内容');
		assert.deepEqual([...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details.ash-design-property-section')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent), ['组件', '设计资源', '图层', '排列', '位置', '布局', '外观', '效果', '文字排版', '矢量工具', '原型']);
		view.pane.editor.selectShape(new DocumentCommands(view.designEditors.document.model).addShape('path', { x: 200, y: 50 })); pressCanvas(view, 'Enter');
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

test('Design browser close does not show a manual save confirmation', () => {
	const page = createView();
	try {
		pressCanvas(page, 'r');
		const before = new browser.window.Event('beforeunload', { cancelable: true });
		browser.window.dispatchEvent(before);
		assert.equal(before.defaultPrevented, false);
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
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		assert.ok(view.domNode.querySelector('button[aria-label="选择工具"]'));
		assert.ok(view.domNode.querySelector('button[aria-label="形状工具"]'));
		createText(view);
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

test('Design shutdown automatically saves hidden documents without asking to save', async () => {
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
		assert.equal(await isVetoed(), false);
		assert.equal(designEditors.document.isDirty, false);
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
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		assert.equal(view.layersDomNode.querySelector('[role="tree"]')!.getAttribute('aria-label'), '图层');
		assert.match(view.layersDomNode.textContent!, /绘制对象后会显示对应图层。/u);
		assert.equal(view.propertiesDomNode.querySelector('.ash-design-properties-heading')!.textContent, '页面');
		assert.equal(view.propertiesDomNode.querySelector('.ash-design-page-summary'), null);
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="页面背景颜色"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="页面背景不透明度（%）"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="描边不透明度（%）"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="阴影不透明度（%）"]'));
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
	assert.deepEqual([...view.propertiesDomNode.querySelectorAll<HTMLDetailsElement>('details.ash-design-property-section')].filter(section => !section.hidden).map(section => section.querySelector('summary')!.textContent), ['Components', 'Design resources', 'Layer', 'Arrange', 'Position', 'Layout', 'Appearance', 'Effects', 'Image crop', 'Constraints', 'Prototype']);
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
	editor.selectShape(image.id);
	const blend = view.propertiesDomNode.querySelector<HTMLSelectElement>('[aria-label="Layer blend mode"]')!; blend.value = 'plus-darker'; blend.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	const filterSource = view.domNode.querySelector('feImage')!.getAttribute('href')!;
	assert.match(decodeURIComponent(filterSource.slice(filterSource.indexOf(',') + 1)), /href="data:image\/png;base64,/u);
	controller.model.undo();
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
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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

test('Design layout properties edit nested geometry, rename layers and save the same resolved document', async () => {
	using view = createView();
	const model = view.designEditors.document.model;
	pressCanvas(view, 'r');
	pressCanvas(view, 'e');
	pressCanvas(view, 'a', { ctrlKey: true });
	pressCanvas(view, 'A', { shiftKey: true });
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	const input = (label: string): HTMLInputElement => view.propertiesDomNode.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
	const select = (label: string, value: string): void => {
		const control = view.propertiesDomNode.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
		control.value = value; control.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	};
	input('Layer name').value = 'Navigation';
	input('Layer name').dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(view.layersDomNode.textContent!, /Navigation/u);
	select('Layout flow', 'vertical');
	input('Gap').value = '24';
	input('Gap').dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	const frame = model.value.shapes[0];
	assert.equal(frame.kind, 'frame');
	if (frame.kind !== 'frame') { return; }
	assert.deepEqual([frame.width, frame.height, frame.children[1].y], [144, 208, 116]);
	assert.match(editor.getAccessibleContent(), /Navigation[\s\S]*Vertical auto layout; gap 24/u);
	editor.selectShape(frame.children[0].id);
	select('Width sizing', 'fill');
	assert.equal(input('X').disabled, true, 'auto layout owns child position');
	const filled = model.value.shapes[0] as typeof frame;
	assert.equal(filled.autoLayout!.width, 'fixed');
	assert.equal(filled.children[0].sizing!.width, 'fill');
	editor.selectShape(frame.id);
	input('Width').value = '300'; input('Width').dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal((model.value.shapes[0] as typeof frame).children[0].width, 276);
	const { generateDesignCode } = await import('../../contrib/creator/contrib/code/browser/designCodeGenerator.js');
	const html = generateDesignCode(model.value);
	assert.match(html, /display: flex; flex-direction: column;[^{]*row-gap: 24px/u);
	assert.match(html, /width: auto; align-self: stretch/u);
	await view.designEditors.document.saveDocument();
	assert.deepEqual(parseDesignDocument(fileContent), model.value);
	assert.equal(view.designEditors.document.isDirty, false);
	editor.undo();
	assert.equal((model.value.shapes[0] as typeof frame).children[0].width, 120);
	editor.redo();
	assert.equal(view.designEditors.document.isDirty, false);
	select('Layout flow', 'none');
	assert.equal((model.value.shapes[0] as typeof frame).autoLayout, undefined);
	editor.selectShape(frame.children[0].id);
	select('Horizontal constraint', 'end');
	editor.selectShape(frame.id);
	input('Width').value = '400'; input('Width').dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal((model.value.shapes[0] as typeof frame).children[0].x, 112);
});

test('Design layer shortcuts duplicate containers and reorder children through the shared history', () => {
	using view = createView();
	pressCanvas(view, 'r'); pressCanvas(view, 'e');
	pressCanvas(view, 'a', { ctrlKey: true }); pressCanvas(view, 'A', { shiftKey: true });
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	const model = view.designEditors.document.model;
	const frame = model.value.shapes[0];
	if (frame.kind !== 'frame') { assert.fail('Expected auto layout frame'); }
	pressCanvas(view, 'd', { metaKey: true });
	assert.equal(model.value.shapes.length, 2);
	const copy = model.value.shapes[1];
	assert.notEqual(copy.id, frame.id);
	assert.equal(editor.selection.ids.has(copy.id), true);
	pressCanvas(view, '[', { ctrlKey: true });
	assert.deepEqual(model.value.shapes.map(shape => shape.id), [copy.id, frame.id]);
	editor.selectShape(frame.children[0].id);
	const tree = view.layersDomNode.querySelector<HTMLElement>('[role="tree"]')!;
	tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: ']', ctrlKey: true, bubbles: true, cancelable: true }));
	assert.deepEqual((model.value.shapes[1] as typeof frame).children.map(shape => shape.id), [frame.children[1].id, frame.children[0].id]);
	editor.undo();
	assert.deepEqual((model.value.shapes[1] as typeof frame).children.map(shape => shape.id), frame.children.map(shape => shape.id));
});

test('Chinese Design layout controls and accessibility help describe the editing behavior', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		pressCanvas(view, 'r'); pressCanvas(view, 'A', { shiftKey: true });
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="图层名称"]'));
		assert.ok(view.propertiesDomNode.querySelector('select[aria-label="布局方向"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="间距"]'));
		assert.match(view.propertiesDomNode.textContent!, /适应内容/u);
		assert.ok(view.propertiesDomNode.querySelector('select[aria-label="自动换行"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="最小宽度"]'));
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="列数"]'));
		assert.match(chinese.bundles.ash['sessions.design.responsiveLayoutHelp'], /跨越单元格[\s\S]*尺寸限制/u);
		assert.match(chinese.bundles.ash['sessions.design.layoutHelp'], /Shift\+A[\s\S]*约束/u);
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /横向自动布局/u);
	} finally { resetNlsResolver(); }
});

test('Design grid, wrapping and size limits edit one undoable document and reject conflicting bounds', async () => {
	using view = createView();
	pressCanvas(view, 'r'); pressCanvas(view, 'e'); pressCanvas(view, 'r');
	pressCanvas(view, 'a', { ctrlKey: true }); pressCanvas(view, 'A', { shiftKey: true });
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	const model = view.designEditors.document.model;
	const frame = (): Extract<DesignShape, { kind: 'frame'; }> => model.value.shapes[0] as Extract<DesignShape, { kind: 'frame'; }>;
	const input = (name: string): HTMLInputElement => view.propertiesDomNode.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
	const number = (name: string, value: string): void => { const field = input(name); field.value = value; field.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	const select = (name: string, value: string): void => { const field = view.propertiesDomNode.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!; field.value = value; field.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	select('Wrap', 'wrap'); number('Width', '300'); number('Line gap', '16');
	assert.deepEqual(frame().children.map(child => [child.x, child.y]), [[12, 12], [144, 12], [12, 108]]);
	assert.equal(frame().height, 200);
	number('Max width', '280');
	assert.equal(frame().width, 280);
	number('Min width', '300');
	assert.equal(input('Min width').getAttribute('aria-invalid'), 'true');
	assert.equal(frame().sizeLimits?.minWidth, undefined);
	number('Min width', '200'); number('Max width', '');
	assert.deepEqual(frame().sizeLimits, { minWidth: 200 });
	select('Layout flow', 'grid');
	assert.equal(frame().autoLayout?.wrap, false);
	assert.equal(frame().autoLayout?.grid?.columns.length, 2);
	number('Columns', '3'); number('Rows', '2');
	select('Column track', '1'); select('Column sizing', 'fixed'); number('Column pixels / fraction', '50');
	assert.deepEqual(frame().autoLayout?.grid?.columns[1], { sizing: 'fixed', value: 50 });
	number('Rows', '');
	assert.equal(frame().autoLayout?.grid?.autoRows, true);
	select('Cell positioning', 'manual');
	const child = frame().children[0];
	editor.selectShape(child.id);
	number('Column span', '2'); number('Row', '2');
	assert.equal(frame().children[0].sizing?.width, 'fill');
	assert.deepEqual(frame().children[0].gridCell, { column: 1, row: 2, columnSpan: 2 });
	select('Horizontal cell alignment', 'end');
	number('Max width', '80');
	assert.equal(frame().children[0].width, 80);
	assert.match(editor.getAccessibleContent(), /Grid auto layout[\s\S]*Column span 2[\s\S]*Width limits: None to 80/u);
	const version = model.version;
	number('Column span', '4');
	assert.equal(model.version, version, 'spans larger than the current column count are rejected by the field');
	editor.undo();
	assert.equal(frame().children[0].sizeLimits, undefined);
	editor.redo();
	assert.equal(frame().children[0].sizeLimits?.maxWidth, 80);
	await view.designEditors.document.saveDocument();
	assert.deepEqual(parseDesignDocument(fileContent), model.value);
	const { generateDesignCode } = await import('../../contrib/creator/contrib/code/browser/designCodeGenerator.js');
	assert.match(generateDesignCode(model.value), /display: grid; grid-template-columns:[^;]+50px/u);
	assert.match(generateDesignCode(model.value), /grid-column: 1 \/ span 2; grid-row: 2 \/ span 1/u);
	assert.match(generateDesignCode(model.value), /max-width: 80px/u);
	editor.selectShape(frame().id);
	assert.equal(input('Column pixels / fraction').value, '1', 'returning to the frame resets the track picker and its value together');
	number('Columns', '1'); number('Rows', '1');
	assert.equal(frame().children.length, 3);
	assert.deepEqual(frame().children[0].gridCell, { column: 1, row: 1, columnSpan: 1, horizontal: 'end' });
	editor.undo(); editor.undo();
	assert.equal(frame().children[0].gridCell?.columnSpan, 2);
});

test('Design component controls create variants, preserve text overrides, reset, detach and save through one document', async () => {
	using view = createView(); const editor = DesignEditorWidget.getFocused(view.domNode)!; const model = view.designEditors.document.model;
	const button = (label: string): void => { const button = [...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!; assert.ok(button, label); button.click(); };
	const field = (label: string, value: string): void => { const input = view.propertiesDomNode.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	createText(view); pressCanvas(view, 'k', { ctrlKey: true, altKey: true });
	const source = model.value.shapes[0]; assert.equal(source.kind === 'frame' && source.component?.kind, 'main');
	button('Add variant'); const set = model.value.shapes[0]; assert.equal(set.kind === 'frame' && set.component?.kind, 'set');
	field('Value: State', 'Hover'); button('Add variant property'); field('Property name: Property 2', 'Size');
	button('Create instance');
	const instance = model.value.shapes[1]; if (instance.kind !== 'frame') { assert.fail('Expected instance'); }
	assert.equal(instance.instance?.componentId, set.kind === 'frame' ? set.children[1].id : undefined);
	editor.selectShape(instance.children[0].id);
	const content = view.propertiesDomNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text content"]')!;
	content.value = 'Custom instance'; content.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(view.propertiesDomNode.querySelector<HTMLInputElement>('input[aria-label="X"]')!.disabled, true);
	editor.selectShape(instance.id);
	const choice = view.propertiesDomNode.querySelector<HTMLSelectElement>('select[aria-label="Variant: State"]')!;
	choice.value = 'Variant 1'; choice.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(editor.getAccessibleContent(), /Instance of[\s\S]*Custom instance/u);
	button('Reset all overrides'); assert.doesNotMatch(editor.getAccessibleContent(), /Custom instance/u);
	editor.undo(); assert.match(editor.getAccessibleContent(), /Custom instance/u);
	await view.designEditors.document.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent), model.value);
	pressCanvas(view, 'b', { metaKey: true, altKey: true });
	assert.equal((model.value.shapes[1] as typeof instance).instance, undefined);
	editor.undo(); assert.ok((model.value.shapes[1] as typeof instance).instance);
	button('Go to main component'); assert.equal(editor.selection.ids.has(source.id), true);
});

test('Chinese component labels, variants and accessibility instructions use the product language pack', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); pressCanvas(view, 'r'); pressCanvas(view, 'k', { ctrlKey: true, altKey: true });
		[...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '添加变体')!.click();
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="属性名称：状态"]'));
		[...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '创建实例')!.click();
		assert.ok(view.propertiesDomNode.querySelector('select[aria-label="变体：状态"]'));
		assert.ok([...view.propertiesDomNode.querySelectorAll('button')].find(button => button.textContent === '重置全部覆盖'));
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /主组件[\s\S]*的实例/u);
		assert.match(chinese.bundles.ash['sessions.design.componentsHelp'], /嵌套实例[\s\S]*撤销/u);
	} finally { resetNlsResolver(); }
});

test('Design resource controls bind modes, reject invalid values, create styles and preserve keyboard focus and saved references', async () => {
	using view = createView(); const editor = DesignEditorWidget.getFocused(view.domNode)!; const model = editor.documentController.model;
	pressCanvas(view, 'r'); const id = model.value.shapes[0].id;
	const button = (name: string): HTMLButtonElement => [...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!;
	const input = (key: string): HTMLInputElement => view.propertiesDomNode.querySelector<HTMLInputElement>(`[data-resource-control="${key}"]`)!;
	const change = (key: string, value: string): void => { const field = input(key); field.focus(); field.value = value; field.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	button('Create collection').click(); change('collectionName', 'Theme'); button('Add mode').click();
	const collection = model.value.resources!.collections[0]; const light = collection.defaultMode; const dark = collection.modes[1].id;
	change(`modeName:${dark}`, 'Dark'); button('Create variable').click(); change('variableName', 'Brand');
	const variable = model.value.resources!.variables[0].id;
	change(`value:${light}`, '#abcdef'); assert.equal(browser.window.document.activeElement?.getAttribute('data-resource-control'), `value:${light}`);
	const version = model.version; change(`value:${light}`, 'bad color'); assert.equal(model.version, version); assert.ok(input(`value:${light}`).validationMessage);
	change(`value:${light}`, '#abcdef'); change(`value:${dark}`, '#123456'); change('binding', variable);
	assert.equal(model.value.shapes[0].fill, '#abcdef'); change(`mode:${collection.id}`, dark); assert.equal(model.value.shapes[0].fill, '#123456');
	button('Create style from selection').click(); assert.equal(model.value.resources!.styles.length, 1); assert.equal(model.value.resources!.styles[0].bindings?.fill, variable);
	assert.equal(input('binding').value, '@style');
	change('binding', ''); assert.equal(model.value.shapes[0].fill, '#123456'); assert.equal(model.value.shapes[0].styleBindings?.fill, undefined); editor.undo();
	assert.match(editor.getAccessibleContent(), /Brand/u);
	await editor.documentController.saveDocument(); const saved = parseDesignDocument(fileContent); assert.equal(saved.shapes[0].id, id); assert.equal(saved.shapes[0].styleBindings?.fill, saved.resources!.styles[0].id);
	editor.undo(); assert.equal(model.value.resources!.styles.length, 0); editor.redo(); assert.equal(model.value.resources!.styles.length, 1);
});

test('Design library files publish media and review updates before changing consumers, preserving overrides and undo', async () => {
	fileContent = ''; errors = [];
	using publisher = services.createInstance(DesignDocumentController, CreatorMode.Design);
	const { DocumentCommands } = await import('../../contrib/creator/common/commands/documentCommands.js');
	const author = new DocumentCommands(publisher.model);
	const label: DesignShape = { id: generateUuid(), kind: 'text', text: 'Initial', fontSize: 16, x: 0, y: 0, width: 100, height: 24, fill: '#123456', rotation: 0 };
	const bytes = new Uint8Array([137, 80, 78, 71]); const sha256 = createHash('sha256').update(bytes).digest('hex');
	const assetId = generateUuid(); const versionId = generateUuid();
	const picture: DesignShape = { id: generateUuid(), kind: 'image', assetId, assetVersionId: versionId, x: 110, y: 0, width: 20, height: 20, rotation: 0, fill: '#ffffff', crop: { x: 0, y: 0, width: 1, height: 1 } };
	const main: DesignShape = { id: generateUuid(), kind: 'frame', name: 'Button', x: 0, y: 0, width: 140, height: 40, rotation: 0, fill: '#ffffff', clip: false, children: [label, picture], component: { kind: 'main' } };
	publisher.restoreBackup(JSON.stringify({ manifest: serializeDesignDocument(documentFromShapes([main], undefined, [{ id: assetId, name: 'Icon', versions: [{ id: versionId, sha256, path: `assets/${sha256}`, mediaType: 'image/png', width: 20, height: 20 }] }])), media: { [sha256]: Buffer.from(bytes).toString('base64') } }));
	author.insertShape({ ...label, id: generateUuid(), text: 'Unpublished notes', x: 1000 });
	await publisher.publishLibrary(); const initialPublication = fileContent; assert.equal(JSON.parse(fileContent).kind, 'ash-design-library'); assert.equal(JSON.stringify(JSON.parse(fileContent).document).includes('Unpublished notes'), false);
	using view = createView(); const consumer = view.designEditors.document; const commands = new DocumentCommands(consumer.model);
	await consumer.addLibrary(); assert.equal(consumer.model.value.resources!.libraries.length, 1);
	const id = commands.components.createInstance(main.id)!; const current = () => consumer.model.value.shapes[0] as Extract<DesignShape, { kind: 'frame'; }>;
	const child = current().children[0]; assert.equal(current().instance!.componentId, main.id);
	commands.updateShape({ ...child, kind: 'text', text: 'My label', fontSize: 16 });
	author.updateShape({ ...label, text: 'Published', fill: '#ff0000' }); await publisher.publishLibrary();
	assert.notEqual(fileContent, initialPublication); await consumer.checkLibraryUpdate(publisher.model.value.documentId);
	assert.equal(current().children[0].fill, '#123456'); assert.ok(consumer.getLibraryUpdate(publisher.model.value.documentId));
	assert.match(view.propertiesDomNode.textContent!, /Review the published changes/u);
	const accept = [...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Accept update:'))!; accept.click();
	assert.equal(current().children[0].fill, '#ff0000'); assert.equal((current().children[0] as Extract<DesignShape, { kind: 'text'; }>).text, 'My label');
	consumer.model.undo(); assert.equal(current().children[0].fill, '#123456'); consumer.model.redo();
	const savingFrom = writes.length;
	assert.equal(await consumer.saveDocument(), true);
	// The publisher can autosave too; inspect the consumer's write rather than the fixture's last write across all documents.
	const savedWrite = writes.slice(savingFrom).reverse().find(write => JSON.parse(write.content).documentId === consumer.model.value.documentId);
	assert.ok(savedWrite);
	const saved = parseDesignDocument(savedWrite.content);
	assert.deepEqual(saved, consumer.model.value);
	assert.equal(saved.resources!.libraries[0].document.shapes[0].id, main.id);
	assert.deepEqual(consumer.readMedia(saved.assets[0].versions[0]), bytes); assert.deepEqual(errors, []);
});

test('Design library imports reject corrupt media without changing the active document', async () => {
	errors = [];
	using view = createView(); const controller = view.designEditors.document; pressCanvas(view, 'r'); const before = serializeDesignDocument(controller.model.value);
	const assetId = generateUuid(); const versionId = generateUuid(); const hash = '0'.repeat(64);
	const snapshot = documentFromShapes([], undefined, [{ id: assetId, name: 'Corrupt', versions: [{ id: versionId, sha256: hash, path: `assets/${hash}`, mediaType: 'image/png', width: 10, height: 10 }] }]);
	fileContent = JSON.stringify({ kind: 'ash-design-library', name: 'Broken', document: JSON.parse(serializeDesignDocument(snapshot)), media: { [hash]: 'YWJj' } });
	await controller.addLibrary(); assert.equal(serializeDesignDocument(controller.model.value), before); assert.deepEqual(errors, ['Could not update the design library.']); errors = [];
});

test('Design text, effect and layout guide styles render safely and artwork exports omit guides', async () => {
	using view = createView(); const controller = view.designEditors.document;
	const label: DesignShape = { id: generateUuid(), kind: 'text', x: 0, y: 0, width: 100, height: 80, rotation: 0, fill: '#abcdef', text: 'First\nSecond', fontSize: 20, fontFamily: 'serif', fontWeight: 700, lineHeight: 30, letterSpacing: 2, effects: { x: 0, y: 4, blur: 8, color: '#00000080' } };
	controller.model.applyEdit([{ id: generateUuid(), kind: 'frame', x: 0, y: 0, width: 200, height: 100, rotation: 0, fill: '#ffffff', clip: false, children: [label], layoutGuide: { size: 8, color: '#ff000040' } }]);
	const text = view.domNode.querySelector<HTMLElement>('[data-design-text]')!; assert.equal(text.style.fontFamily, 'serif'); assert.equal(text.style.fontWeight, '700'); assert.equal((text.children[1] as HTMLElement).style.lineHeight, '30px'); assert.ok(view.domNode.querySelector('[data-layout-guide]'));
	const { exportDesignSvg } = await import('../../contrib/creator/browser/svgRenderer.js'); const svg = exportDesignSvg(controller.model.value); assert.ok(!svg.includes('data-layout-guide')); assert.match(svg, /drop-shadow/u); assert.match(svg, /letter-spacing: 2px/u);
	const { generateDesignCode } = await import('../../contrib/creator/contrib/code/browser/designCodeGenerator.js'); const code = generateDesignCode(controller.model.value); assert.match(code, /filter: drop-shadow\(0px 4px 4px #00000080\)/u);
});

test('Chinese Design resource controls and accessibility help use translated names', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); pressCanvas(view, 'r');
		assert.match(view.propertiesDomNode.textContent!, /设计资源/u); assert.match(view.propertiesDomNode.textContent!, /发布组件库/u);
		const button = [...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '创建集合')!; button.click();
		assert.ok(view.propertiesDomNode.querySelector('input[aria-label="集合名称"]'));
		assert.ok(view.propertiesDomNode.querySelector('select[aria-label="变量类型"]'));
		assert.match(chinese.bundles.ash['sessions.design.resourcesHelp'], /接受更新.*保留实例覆盖/u);
	} finally { resetNlsResolver(); }
});

function prototypeScreens(): { home: Extract<DesignShape, { kind: 'frame'; }>; detail: Extract<DesignShape, { kind: 'frame'; }>; dialog: Extract<DesignShape, { kind: 'frame'; }>; } {
	const frame = (name: string): Extract<DesignShape, { kind: 'frame'; }> => ({ id: generateUuid(), kind: 'frame', name, x: 0, y: 0, width: 390, height: 844, rotation: 0, fill: '#ffffff', clip: true, children: [] });
	return { home: frame('Home'), detail: frame('Detail'), dialog: { ...frame('Dialog'), width: 160, height: 100 } };
}

test('Prototype properties author interactions and transitions, save them, and retain undo and keyboard focus', async () => {
	using view = createView(); const editor = view.pane.editor; const controller = view.designEditors.document; const { home, detail } = prototypeScreens();
	controller.model.replace(documentFromShapes([home, detail])); editor.selectShape(home.id);
	const root = view.propertiesDomNode.querySelector<HTMLDetailsElement>('.ash-prototype-properties')!; root.open = true;
	const click = (name: string): void => { const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name); assert.ok(button, name); button.click(); };
	const change = (name: string, value: string): void => { const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)!; input.focus(); input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	click('Add interaction'); assert.equal(controller.model.value.shapes[0].flowStart, 'Flow 1');
	change('Transition', 'smart'); change('Duration (ms)', '450'); change('Easing', 'easeInOut');
	assert.equal(browser.window.document.activeElement?.getAttribute('aria-label'), 'Easing');
	assert.deepEqual(controller.model.value.shapes[0].interactions![0].actions[0].transition, { type: 'smart', duration: 450, easing: 'easeInOut', direction: 'left' });
	editor.undo(); assert.equal(controller.model.value.shapes[0].interactions![0].actions[0].transition.easing, 'easeOut'); editor.redo();
	await controller.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent), controller.model.value);
	click('Remove interaction'); assert.equal(controller.model.value.shapes[0].interactions?.length, 0); editor.undo();
	assert.equal(controller.model.value.shapes[0].interactions?.length, 1);
});

test('Prototype preview follows hotspot branches, overlay dismissal and Back, leaving the saved document unchanged', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	using view = createView(); const editor = view.pane.editor; const model = view.designEditors.document.model; const { home, detail, dialog } = prototypeScreens();
	const wire = (action: 'navigate' | 'overlay' | 'close', destination?: string) => ({ id: generateUuid(), trigger: 'click' as const, actions: [{ action, destination, transition: defaultPrototypeTransition }] });
	model.replace(documentFromShapes([{ ...home, interactions: [wire('navigate', detail.id)] }, { ...detail, interactions: [wire('overlay', dialog.id)] }, { ...dialog, interactions: [wire('close')] }]));
	editor.selectShape(home.id); editor.focus(); const version = model.version; const saved = serializeDesignDocument(model.value);
	editor.previewPrototype();
	const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!;
	const scene = preview.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!;
	const activate = (id: string): void => { const button = scene.querySelector<SVGElement>(`[data-shape-id="${id}"]`)!; assert.equal(button.getAttribute('role'), 'button'); assert.equal(button.closest('[aria-hidden="true"]'), null); button.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
	activate(home.id); assert.equal(scene.dataset.screenId, detail.id);
	activate(detail.id); assert.equal(scene.dataset.screenId, dialog.id);
	assert.match(editor.getAccessibleContent(), /Current screen: Dialog/u);
	preview.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(scene.dataset.screenId, detail.id); assert.equal(preview.hidden, false);
	const back = [...preview.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Back')!; back.click(); assert.equal(scene.dataset.screenId, home.id);
	preview.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(preview.hidden, true); assert.equal(browser.window.document.activeElement, editor.domNode);
	assert.equal(model.version, version); assert.equal(serializeDesignDocument(model.value), saved);
});

test('Prototype hover and press restore temporary navigation while mouse enter is permanent', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	for (const trigger of ['hover', 'press', 'enter'] as const) {
		using view = createView(); const editor = view.pane.editor; const { home, detail } = prototypeScreens();
		editor.documentController.model.replace(documentFromShapes([{ ...home, interactions: [{ id: generateUuid(), trigger, actions: [{ action: 'navigate', destination: detail.id, transition: defaultPrototypeTransition }] }] }, detail]));
		editor.selectShape(home.id); editor.previewPrototype();
		const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!; const scene = preview.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!;
		scene.querySelector(`[data-shape-id="${home.id}"]`)!.dispatchEvent(new browser.window.MouseEvent(trigger === 'press' ? 'pointerdown' : 'pointerover', { bubbles: true, button: 0 }));
		assert.equal(scene.dataset.screenId, detail.id);
		if (trigger === 'press') { browser.window.document.dispatchEvent(new browser.window.MouseEvent('pointerup', { bubbles: true })); } else { preview.dispatchEvent(new browser.window.MouseEvent('pointerleave')); }
		assert.equal(scene.dataset.screenId, trigger === 'enter' ? detail.id : home.id);
	}
});

test('Prototype cancels delayed transitions when hidden and renders animation frames without edits', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	using view = createView(); const editor = view.pane.editor; const { home, detail } = prototypeScreens();
	const callbacks = new Map<number, FrameRequestCallback>(); let next = 0;
	const previousRequest = browser.window.requestAnimationFrame, previousCancel = browser.window.cancelAnimationFrame;
	browser.window.requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; };
	browser.window.cancelAnimationFrame = id => { callbacks.delete(id); };
	try {
		editor.documentController.model.replace(documentFromShapes([{ ...home, interactions: [{ id: generateUuid(), trigger: 'click', actions: [{ action: 'navigate', destination: detail.id, transition: { ...defaultPrototypeTransition, type: 'dissolve', duration: 1000, easing: 'linear' } }] }] }, detail]));
		editor.selectShape(home.id); const version = editor.documentController.model.version; editor.previewPrototype();
		const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!;
		preview.querySelector(`[data-shape-id="${home.id}"]`)!.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
		assert.equal(callbacks.size, 1); const [id, tick] = [...callbacks][0]; callbacks.delete(id); tick(browser.window.performance.now() + 500);
		assert.equal(preview.querySelectorAll('.ash-prototype-preview-scene > g').length, 2);
		const opacity = Number(preview.querySelector('.ash-prototype-preview-scene > g')!.getAttribute('opacity')); assert.ok(opacity > 0.4 && opacity < 0.6);
		editor.setVisible(false); assert.equal(callbacks.size, 0); assert.equal(preview.hidden, true); assert.equal(editor.documentController.model.version, version);
	} finally { browser.window.requestAnimationFrame = previousRequest; browser.window.cancelAnimationFrame = previousCancel; }
	const timers = new Map<number, () => void>(); const previousSet = browser.window.setTimeout, previousClear = browser.window.clearTimeout;
	browser.window.setTimeout = ((handler: TimerHandler) => { assert.equal(typeof handler, 'function'); timers.set(++next, handler as () => void); return next; }) as typeof browser.window.setTimeout;
	browser.window.clearTimeout = id => { timers.delete(id!); };
	try {
		editor.documentController.model.replace(documentFromShapes([{ ...home, interactions: [{ id: generateUuid(), trigger: 'delay', delay: 800, actions: [{ action: 'navigate', destination: detail.id, transition: defaultPrototypeTransition }] }] }, detail]));
		await editor.documentController.flushAutoSave();
		editor.selectShape(home.id); editor.previewPrototype(); assert.equal(timers.size, 1);
		const fire = [...timers.values()][0]; fire(); assert.equal(view.domNode.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!.dataset.screenId, detail.id);
		editor.setVisible(false); assert.equal(timers.size, 0);
		editor.previewPrototype(); assert.equal(timers.size, 1); editor.setVisible(false); assert.equal(timers.size, 0);
	} finally { browser.window.setTimeout = previousSet; browser.window.clearTimeout = previousClear; }
});

test('Chinese Prototype properties, triggers and accessible descriptions use translated names', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); const { home, detail } = prototypeScreens(); view.designEditors.document.model.replace(documentFromShapes([home, detail])); view.pane.editor.selectShape(home.id);
		const root = view.propertiesDomNode.querySelector('.ash-prototype-properties')!;
		[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '添加交互')!.click();
		assert.ok(root.querySelector('select[aria-label="触发器"]')); assert.ok(root.querySelector('select[aria-label="过渡"]'));
		assert.match(view.pane.editor.getAccessibleContent(), /点击／轻触时.*跳转至/u);
		assert.match(chinese.bundles.ash['sessions.design.prototype.help'], /智能动画.*未匹配图层溶解/u);
	} finally { resetNlsResolver(); }
});

test('Prototype key, pointer and link triggers use the preview and repeated preview opens restore canvas input', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	for (const trigger of ['key', 'drag', 'down', 'up', 'leave'] as const) {
		using view = createView(); const editor = view.pane.editor; const { home, detail } = prototypeScreens();
		editor.documentController.model.replace(documentFromShapes([{ ...home, interactions: [{ id: generateUuid(), trigger, key: 'k', actions: [{ action: 'navigate', destination: detail.id, transition: defaultPrototypeTransition }] }] }, detail]));
		editor.selectShape(home.id); editor.previewPrototype(); editor.previewPrototype();
		const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!; const scene = preview.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!; const hotspot = scene.querySelector(`[data-shape-id="${home.id}"]`)!;
		if (trigger === 'key') { preview.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'k', bubbles: true })); }
		else if (trigger === 'drag') { hotspot.dispatchEvent(new browser.window.MouseEvent('pointerdown', { button: 0, clientX: 1, clientY: 1, bubbles: true })); preview.dispatchEvent(new browser.window.MouseEvent('pointermove', { clientX: 30, clientY: 1, bubbles: true })); }
		else { hotspot.dispatchEvent(new browser.window.MouseEvent(trigger === 'down' ? 'pointerdown' : trigger === 'up' ? 'pointerup' : 'pointerout', { button: 0, bubbles: true })); }
		assert.equal(scene.dataset.screenId, detail.id, trigger);
		preview.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.equal(!!view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!.inert, false);
	}
	using view = createView(); const { home } = prototypeScreens();
	view.designEditors.document.model.replace(documentFromShapes([{ ...home, interactions: [{ id: generateUuid(), trigger: 'click', actions: [{ action: 'url', url: 'https://example.com/prototype', transition: defaultPrototypeTransition }] }] }]));
	view.pane.editor.previewPrototype();
	const count = openedPrototypeLinks.length;
	view.domNode.querySelector(`.ash-prototype-preview [data-shape-id="${home.id}"]`)!.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
	assert.deepEqual(openedPrototypeLinks.slice(count), ['https://example.com/prototype']);
});

test('Prototype Change to authoring and preview preserve editable component instances', async () => {
	const { DocumentCommands } = await import('../../contrib/creator/common/commands/documentCommands.js');
	using view = createView(); const editor = view.pane.editor; const model = view.designEditors.document.model; const commands = new DocumentCommands(model); const { home } = prototypeScreens();
	const main: Extract<DesignShape, { kind: 'frame'; }> = { ...home, name: 'Button', component: { kind: 'main' }, width: 120, height: 40 };
	model.replace(documentFromShapes([main])); const variant = commands.components.addVariant(main.id)!;
	commands.updateShape({ ...model.value.shapes.flatMap(shape => shape.kind === 'frame' ? shape.children : []).find(shape => shape.id === variant)!, fill: '#ff0000' });
	editor.selectShape(main.id);
	const properties = view.propertiesDomNode.querySelector('.ash-prototype-properties')!;
	[...properties.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add interaction')!.click();
	assert.equal(properties.querySelector<HTMLSelectElement>('[aria-label="Action"]')!.value, 'changeTo');
	const instanceId = commands.components.createInstance(main.id)!; const instance = model.value.shapes.find(shape => shape.id === instanceId)!;
	const page = { ...home, id: generateUuid(), children: [instance] };
	model.applyEdit([...model.value.shapes.filter(shape => shape.id !== instanceId), page]); editor.selectShape(page.id); const saved = serializeDesignDocument(model.value);
	editor.previewPrototype(); const scene = view.domNode.querySelector('.ash-prototype-preview-scene')!;
	scene.querySelector(`[data-shape-id="${instanceId}"]`)!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(scene.querySelector(`[data-shape-id="${instanceId}"]`)!.getAttribute('fill'), '#ff0000');
	assert.equal(serializeDesignDocument(model.value), saved);
});

test('Prototype action editor authors expressions, branches and custom springs, reorders with undo, and saves stable references', async () => {
	const { DocumentCommands } = await import('../../contrib/creator/common/commands/documentCommands.js');
	using view = createView(); const editor = view.pane.editor, model = view.designEditors.document.model, { home, detail, dialog } = prototypeScreens();
	model.replace(documentFromShapes([home, detail, dialog])); const commands = new DocumentCommands(model);
	const collection = commands.resources.addCollection('State'), variable = commands.resources.addVariable(collection, 'count', 'number');
	editor.selectShape(home.id); const root = view.propertiesDomNode.querySelector<HTMLDetailsElement>('.ash-prototype-properties')!; root.open = true;
	const control = (key: string) => { const node = root.querySelector<HTMLElement>(`[data-prototype-control="${key}"]`); assert.ok(node, key); return node; };
	const change = (key: string, value: string): void => { const input = control(key) as HTMLInputElement; input.focus(); input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	control('add').click(); change('actions.0.action', 'setVariable'); change('actions.0.value', 'count + 1');
	assert.equal(model.value.shapes[0].interactions![0].actions[0].variableId, variable);
	const version = model.version; change('actions.0.value', 'count + true'); assert.equal(model.version, version); assert.equal(control('actions.0.value').getAttribute('aria-invalid'), 'true'); assert.match(root.querySelector('[role="alert"]')!.textContent!, /expression/u);
	change('actions.0.value', 'count + 1'); control('actions.add').click(); change('actions.1.action', 'conditional'); change('actions.1.branch.0.condition', 'count >= 1 and count < 4');
	control('actions.1.branch.0.add').click(); change('actions.1.branch.0.0.action', 'navigate'); change('actions.1.branch.0.0.destination', detail.id); change('actions.1.branch.0.0.transition', 'smart'); change('actions.1.branch.0.0.easing', 'spring'); change('actions.1.branch.0.0.mass', '1.5'); change('actions.1.branch.0.0.damping', '9');
	assert.equal(browser.window.document.activeElement, control('actions.1.branch.0.0.damping'));
	assert.match(root.querySelector('.ash-prototype-spring')!.getAttribute('aria-label')!, /mass 1.5.*damping 9/u);
	control('actions.1.branch.1.add').click(); change('actions.1.branch.1.0.action', 'navigate'); change('actions.1.branch.1.0.destination', dialog.id);
	control('actions.1.elseIf').click(); change('actions.1.branch.1.condition', 'count == 4');
	assert.equal(model.value.shapes[0].interactions![0].actions[1].branches!.length, 3);
	control('actions.1.branch.1.remove').click(); control('actions.1.up').click(); assert.equal(model.value.shapes[0].interactions![0].actions[0].action, 'conditional');
	editor.undo(); assert.equal(model.value.shapes[0].interactions![0].actions[0].action, 'setVariable');
	commands.resources.renameVariable(variable, 'cart count'); assert.equal((control('actions.0.value') as HTMLInputElement).value, '(`cart count` + 1)');
	await view.designEditors.document.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent), model.value);
	assert.match(editor.getAccessibleContent(), /Set variable.*Conditional.*Navigate to/u);
});

test('Prototype animated chains defer later effects and cancel the entire continuation when closed or restarted', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	using view = createView(); const editor = view.pane.editor, model = view.designEditors.document.model, { home, detail, dialog } = prototypeScreens();
	model.replace(documentFromShapes([{
		...home, interactions: [{
			id: generateUuid(), trigger: 'click', actions: [
				{ action: 'navigate', destination: detail.id, transition: { ...defaultPrototypeTransition, type: 'smart', easing: 'spring', spring: { mass: 1, stiffness: 100, damping: 8, initialVelocity: 0 } } },
				{ action: 'url', url: 'https://example.com/after-animation', transition: defaultPrototypeTransition },
				{ action: 'overlay', destination: dialog.id, transition: { ...defaultPrototypeTransition, type: 'dissolve', duration: 300 } },
			]
		}]
	}, detail, dialog]));
	const saved = serializeDesignDocument(model.value), callbacks = new Map<number, FrameRequestCallback>(); let next = 0;
	const request = browser.window.requestAnimationFrame, cancel = browser.window.cancelAnimationFrame;
	browser.window.requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; }; browser.window.cancelAnimationFrame = id => { callbacks.delete(id); };
	try {
		editor.selectShape(home.id); editor.previewPrototype(); const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!;
		const click = () => preview.querySelector(`[data-shape-id="${home.id}"]`)!.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
		const tick = () => { assert.equal(callbacks.size, 1); const [id, run] = [...callbacks][0]; callbacks.delete(id); run(browser.window.performance.now() + 100000); };
		const opened = openedPrototypeLinks.length; click(); assert.equal(openedPrototypeLinks.length, opened); tick(); assert.equal(openedPrototypeLinks.length, opened + 1); assert.equal(callbacks.size, 1); tick();
		assert.equal(preview.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!.dataset.screenId, dialog.id);
		const restart = [...preview.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Restart flow')!;
		restart.click(); click(); assert.equal(callbacks.size, 1); restart.click(); assert.equal(callbacks.size, 0); assert.equal(openedPrototypeLinks.length, opened + 1);
		click(); editor.setVisible(false); assert.equal(callbacks.size, 0); assert.equal(openedPrototypeLinks.length, opened + 1); assert.equal(serializeDesignDocument(model.value), saved);
	} finally { browser.window.requestAnimationFrame = request; browser.window.cancelAnimationFrame = cancel; }
});

test('Chinese Prototype action chains, condition errors and spring parameters use localized controls and help', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); const { home, detail } = prototypeScreens(); view.designEditors.document.model.replace(documentFromShapes([home, detail])); view.pane.editor.selectShape(home.id);
		const root = view.propertiesDomNode.querySelector('.ash-prototype-properties')!;
		const click = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click();
		const change = (label: string, value: string) => { const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
		click('添加交互'); change('过渡', 'smart'); change('缓动', 'spring'); assert.ok(root.querySelector('[aria-label="刚度"]')); assert.match(root.querySelector('.ash-prototype-spring')!.getAttribute('aria-label')!, /收敛时长/u);
		change('操作', 'conditional'); change('条件', '2'); assert.match(root.querySelector('[role="alert"]')!.textContent!, /布尔值/u); assert.ok([...root.querySelectorAll('button')].some(button => button.textContent === '添加否则如果'));
		assert.match(chinese.bundles.ash['sessions.design.prototype.help'], /动画依次播放.*自定义弹簧/u);
	} finally { resetNlsResolver(); }
});

test('Prototype scroll controls save undoable settings and preview handles wheel, keyboard and drag without document edits', async () => {
	using view = createView(); const editor = view.pane.editor, model = view.designEditors.document.model, { home } = prototypeScreens();
	const target: DesignShape = { id: generateUuid(), kind: 'rectangle', name: 'Destination', x: 20, y: 800, width: 100, height: 60, rotation: 0, fill: '#ff0000' };
	const fixed: DesignShape = { ...target, id: generateUuid(), name: 'Toolbar', y: 10, height: 30 };
	model.replace(documentFromShapes([{ ...home, height: 200, children: [fixed, target] }])); editor.selectShape(home.id);
	const root = view.propertiesDomNode.querySelector('.ash-prototype-properties')!;
	const control = (key: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-prototype-control="${key}"]`)!;
	const change = (key: string, value: string) => { control(key).focus(); control(key).value = value; control(key).dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	change('overflow', 'vertical'); editor.selectShape(fixed.id); change('scrollPosition', 'fixed');
	assert.match(view.layersDomNode.textContent!, /Toolbar \(Fixed\)/u);
	control('add').click(); change('actions.0.action', 'scrollTo'); change('actions.0.destination', target.id); change('actions.0.transition', 'scroll');
	assert.equal(control('actions.0.direction'), null); assert.equal(browser.window.document.activeElement, control('actions.0.transition'));
	editor.undo(); assert.equal(control('actions.0.transition').value, 'instant');
	await editor.documentController.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent), model.value);
	const saved = serializeDesignDocument(model.value), version = model.version;
	editor.previewPrototype(); const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!, scene = preview.querySelector('.ash-prototype-preview-scene')!;
	const frame = () => scene.querySelector<SVGGraphicsElement>(`[data-shape-id="${home.id}"]`)!;
	const wheel = new browser.window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }); frame().dispatchEvent(wheel);
	assert.equal(wheel.defaultPrevented, true); assert.equal(frame().dataset.scrollY, '120'); assert.equal(scene.querySelector(`[data-shape-id="${fixed.id}"]`)!.getAttribute('y'), '10');
	frame().focus(); frame().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })); assert.equal(frame().dataset.scrollY, '660'); assert.equal(browser.window.document.activeElement, frame());
	frame().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); assert.equal(frame().dataset.scrollY, '0');
	frame().dispatchEvent(new browser.window.MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 180, bubbles: true }));
	scene.dispatchEvent(new browser.window.MouseEvent('pointermove', { clientX: 100, clientY: 80, bubbles: true })); browser.window.document.dispatchEvent(new browser.window.MouseEvent('pointerup', { bubbles: true })); assert.equal(frame().dataset.scrollY, '100');
	// Consume the synthetic click that follows a drag before activating a hotspot.
	scene.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
	scene.querySelector(`[data-shape-id="${fixed.id}"]`)!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(frame().dataset.scrollY, '660');
	assert.match(editor.getAccessibleContent(), /Home: scroll position 0, 660/u);
	[...preview.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Restart flow')!.click(); assert.equal(frame().dataset.scrollY, '0');
	assert.equal(model.version, version); assert.equal(serializeDesignDocument(model.value), saved);
});

test('Prototype scroll animation recomputes fixed and sticky positions per frame, sequences actions and cancels on close', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	using view = createView(); const editor = view.pane.editor, model = view.designEditors.document.model, { home } = prototypeScreens();
	const target: DesignShape = { id: generateUuid(), kind: 'rectangle', x: 0, y: 800, width: 100, height: 60, rotation: 0, fill: '#ff0000' }, sticky: DesignShape = { ...target, id: generateUuid(), y: 100, scrollPosition: 'sticky' }, fixed: DesignShape = { ...target, id: generateUuid(), y: 10, scrollPosition: 'fixed' };
	model.replace(documentFromShapes([{ ...home, height: 200, overflowDirection: 'vertical', children: [target, sticky, fixed], interactions: [{ id: generateUuid(), trigger: 'click', actions: [{ action: 'scrollTo', destination: target.id, transition: { ...defaultPrototypeTransition, type: 'scroll', duration: 1000, easing: 'linear' } }, { action: 'url', url: 'https://example.com/scrolled', transition: defaultPrototypeTransition }] }] }]));
	const callbacks = new Map<number, FrameRequestCallback>(); let next = 0;
	const request = browser.window.requestAnimationFrame, cancel = browser.window.cancelAnimationFrame;
	browser.window.requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; }; browser.window.cancelAnimationFrame = id => { callbacks.delete(id); };
	try {
		editor.selectShape(home.id); editor.previewPrototype(); const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!, scene = preview.querySelector('.ash-prototype-preview-scene')!;
		const click = () => scene.querySelector(`[data-shape-id="${home.id}"]`)!.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
		const tick = (offset: number) => { const [id, callback] = [...callbacks][0]; callbacks.delete(id); callback(browser.window.performance.now() + offset); };
		const opened = openedPrototypeLinks.length; click(); tick(500);
		assert.equal(scene.querySelector(`[data-shape-id="${fixed.id}"]`)!.getAttribute('y'), '10'); assert.equal(scene.querySelector(`[data-shape-id="${sticky.id}"]`)!.getAttribute('y'), '0'); assert.equal(openedPrototypeLinks.length, opened);
		tick(1500); assert.equal(openedPrototypeLinks.length, opened + 1); assert.equal(scene.querySelector<SVGElement>(`[data-shape-id="${home.id}"]`)!.dataset.scrollY, '660');
		[...preview.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Restart flow')!.click(); click(); assert.equal(callbacks.size, 1); editor.setVisible(false); assert.equal(callbacks.size, 0);
	} finally { browser.window.requestAnimationFrame = request; browser.window.cancelAnimationFrame = cancel; }
});

test('Chinese Prototype overflow, fixed positioning, Scroll to and keyboard help use translated controls', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); const editor = view.pane.editor, { home } = prototypeScreens();
		const target: DesignShape = { id: generateUuid(), kind: 'rectangle', name: '页脚', x: 0, y: 900, width: 100, height: 60, rotation: 0, fill: '#ff0000' };
		view.designEditors.document.model.replace(documentFromShapes([{ ...home, overflowDirection: 'vertical', children: [target] }])); editor.selectShape(home.id);
		const root = view.propertiesDomNode.querySelector('.ash-prototype-properties')!; assert.ok(root.querySelector('[aria-label="溢出滚动"]'));
		editor.selectShape(target.id); const field = root.querySelector<HTMLSelectElement>('[aria-label="滚动定位"]')!; assert.deepEqual([...field.options].map(option => option.textContent), ['随父层滚动', '固定', '粘性']);
		assert.match(chinese.bundles.ash['sessions.design.prototype.scrollHelp'], /粘性.*直接父层边界/u);
		editor.previewPrototype(); assert.match(view.domNode.querySelector('.ash-prototype-preview [data-scroll-y]')!.getAttribute('aria-label')!, /垂直滚动位置/u);
	} finally { resetNlsResolver(); }
});

test('Scrolling preview keeps pending delay deadlines and respects reduced motion for Scroll to', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	using view = createView(); const editor = view.pane.editor, { home } = prototypeScreens();
	const target: DesignShape = { id: generateUuid(), kind: 'rectangle', x: 0, y: 800, width: 100, height: 60, rotation: 0, fill: '#ff0000' };
	view.designEditors.document.model.replace(documentFromShapes([{ ...home, height: 200, overflowDirection: 'vertical', children: [target], interactions: [{ id: generateUuid(), trigger: 'delay', delay: 5000, actions: [{ action: 'scrollTo', destination: target.id, transition: { ...defaultPrototypeTransition, type: 'scroll' } }] }] }]));
	const timers = new Map<number, () => void>(); let next = 0;
	const timeout = browser.window.setTimeout, clear = browser.window.clearTimeout, media = browser.window.matchMedia;
	browser.window.setTimeout = ((callback: () => void) => { timers.set(++next, callback); return next; }) as typeof timeout; browser.window.clearTimeout = id => { if (id !== undefined) { timers.delete(id); } };
	browser.window.matchMedia = query => ({ matches: true, media: query, onchange: null, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; } });
	try {
		editor.selectShape(home.id); editor.previewPrototype(); const preview = view.domNode.querySelector<HTMLElement>('.ash-prototype-preview')!, frame = () => preview.querySelector<SVGElement>(`[data-shape-id="${home.id}"]`)!;
		const pending = [...timers.keys()]; assert.equal(pending.length, 1);
		frame().dispatchEvent(new browser.window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })); assert.deepEqual([...timers.keys()], pending);
		timers.get(pending[0])!(); assert.equal(frame().dataset.scrollY, '660'); assert.equal(timers.size, 0);
	} finally { browser.window.setTimeout = timeout; browser.window.clearTimeout = clear; browser.window.matchMedia = media; }
});

test('Design inline text commits composition, formats selections and groups typing undo', () => {
	using view = createView();
	view.layout({ width: 400, height: 300 });
	createText(view); pressCanvas(view, 'Enter');
	const editor = () => view.domNode.querySelector<HTMLElement>('[contenteditable="true"]')!;
	assert.equal(browser.window.document.activeElement, editor());
	const input = (text: string) => editor().dispatchEvent(new browser.window.InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
	input('Hello'); input(' world');
	assert.equal(editor().textContent, 'Hello world');
	view.designEditors.document.model.undo(); assert.equal(editor().textContent, 'Text');
	view.designEditors.document.model.redo(); assert.equal(editor().textContent, 'Hello world');
	editor().dispatchEvent(new browser.window.CompositionEvent('compositionstart', { bubbles: true }));
	editor().textContent = '你好 world';
	editor().dispatchEvent(new browser.window.InputEvent('input', { bubbles: true, isComposing: true }));
	assert.equal((view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>).text, 'Hello world');
	editor().dispatchEvent(new browser.window.CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
	assert.equal((view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>).text, '你好 world');
	const range = browser.window.document.createRange(); const node = editor().querySelector('span')!.firstChild!;
	range.setStart(node, 0); range.setEnd(node, 2); const selection = browser.window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
	editor().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
	const shape = view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>;
	assert.deepEqual(shape.textRuns, [{ start: 0, end: 2, style: { fontWeight: 700 } }]);
	editor().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(editor(), null);
	assert.equal(view.domNode.querySelector('[data-shape-id]')?.getAttribute('visibility'), null);
});

test('Design character controls keep canvas selection, report mixed values and preserve clipboard typography safely', async () => {
	using view = createView(); view.layout({ width: 400, height: 300 }); createText(view); pressCanvas(view, 'Enter');
	const editor = () => view.domNode.querySelector<HTMLElement>('[contenteditable="true"]')!;
	editor().dispatchEvent(new browser.window.InputEvent('beforeinput', { inputType: 'insertText', data: 'Hello world', bubbles: true, cancelable: true }));
	const range = browser.window.document.createRange(); const node = editor().querySelector('span')!.firstChild!; range.setStart(node, 0); range.setEnd(node, 5);
	const selection = browser.window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); browser.window.document.dispatchEvent(new browser.window.Event('selectionchange'));
	const size = view.propertiesDomNode.querySelector<HTMLInputElement>('[aria-label="Font size"]')!; size.focus(); size.value = '36'; size.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	const shape = view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>;
	assert.equal(shape.fontSize, 24); assert.deepEqual(shape.textRuns, [{ start: 0, end: 5, style: { fontSize: 36 } }]);
	editor().focus(); view.pane.editor.selectAll(); assert.equal(size.value, ''); assert.equal(size.placeholder, 'Mixed');
	const data = new Map<string, string>();
	const clipboard = (type: string) => { const event = new browser.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '' } }); editor().dispatchEvent(event); };
	clipboard('copy'); assert.equal(data.get('text/plain'), 'Hello world'); assert.ok(data.get('text/html')?.includes('36px'));
	clipboard('paste'); assert.equal((view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>).textRuns?.[0].style.fontSize, 36);
	data.clear(); data.set('text/html', '<p><b>Safe</b> <i>text</i><img src="https://invalid.test/image" onerror="alert(1)"><script>bad()</script></p>');
	view.pane.editor.selectAll(); clipboard('paste');
	const pasted = view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>;
	assert.equal(pasted.text, 'Safe text'); assert.equal(pasted.textRuns?.[0].style.fontWeight, 700); assert.equal(pasted.textRuns?.at(-1)?.style.fontStyle, 'italic'); assert.equal(editor().querySelector('script, img'), null);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(view.designEditors.document.model.value)), view.designEditors.document.model.value);
	const { readDesignTextHtml } = await import('../../contrib/creator/contrib/text/browser/textClipboard.js');
	assert.equal(readDesignTextHtml(browser.window.document, '<div><div>A</div>\n<div>B</div></div>').text, 'A\nB');
});

test('Replacing a document cancels an unfinished text composition without writing into the replacement', () => {
	using view = createView(); view.layout({ width: 400, height: 300 }); createText(view); pressCanvas(view, 'Enter');
	const editor = view.domNode.querySelector<HTMLElement>('[contenteditable]')!; editor.dispatchEvent(new browser.window.CompositionEvent('compositionstart', { bubbles: true })); editor.textContent = '尚未提交';
	const model = view.designEditors.document.model; const original = model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>;
	model.replace(documentFromShapes([{ ...original, text: 'Replacement' }]));
	assert.equal((model.value.shapes[0] as typeof original).text, 'Replacement'); assert.equal(model.canUndo, false); assert.equal(view.domNode.querySelector('[contenteditable]'), null);
});

test('Chinese text typography controls and inline editing use the Design accessibility help', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); view.layout({ width: 400, height: 300 }); createText(view); pressCanvas(view, 'Enter');
		assert.ok(view.domNode.querySelector('[aria-label="编辑文本"]'));
		for (const label of ['文本尺寸', '字距单位', '垂直对齐', 'OpenType 特性', '可变字体轴', '最大行数', '换行样式']) { assert.ok(view.propertiesDomNode.querySelector(`[aria-label="${label}"]`), label); }
		view.propertiesDomNode.querySelector<HTMLElement>('[aria-label="可变字体轴"]')!.focus();
		assert.match(chinese.bundles.ash['sessions.design.textEditingHelp'], /输入法.*自动宽度/u);
		assert.match(view.domNode.querySelector('[contenteditable]')!.getAttribute('aria-description')!, /文本编辑帮助/u);
	} finally { resetNlsResolver(); }
});

test('Design edits text inside scaled rotated groups and keeps the character editor in local coordinates', () => {
	using view = createView(); view.layout({ width: 600, height: 400 });
	const label: Extract<DesignShape, { kind: 'text'; }> = { id: generateUuid(), kind: 'text', text: 'Grouped', fontSize: 20, x: 10, y: 5, width: 100, height: 30, rotation: 0, fill: '#000000', lineHeight: 25, textRuns: [{ start: 0, end: 3, style: { fontSize: 30, letterSpacing: 2 } }] };
	const group: DesignShape = { id: generateUuid(), kind: 'group', x: 100, y: 80, width: 240, height: 120, contentWidth: 120, contentHeight: 60, rotation: 30, fill: '#808080', children: [label] };
	const model = view.designEditors.document.model; model.replace(documentFromShapes([group]));
	// The text centre is (220, 120) before the parent's rotation around (220, 140).
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	viewport.dispatchEvent(new browser.window.MouseEvent('dblclick', { clientX: 230, clientY: 140 - 20 * Math.cos(Math.PI / 6), bubbles: true }));
	const editor = view.domNode.querySelector<HTMLElement>('[contenteditable]')!; assert.ok(editor);
	const overlay = editor.closest('.ash-sessions-design-text-editor')!; assert.match(overlay.getAttribute('transform')!, /rotate\(30\) scale\(2\)/u); assert.equal(overlay.getAttribute('width'), '100');
	editor.dispatchEvent(new browser.window.InputEvent('beforeinput', { inputType: 'insertText', data: 'Edited', bubbles: true, cancelable: true }));
	const updated = (model.value.shapes[0] as Extract<DesignShape, { kind: 'group'; }>).children[0] as typeof label;
	assert.equal(updated.text, 'Edited'); assert.equal(updated.fontSize, 20); assert.equal(updated.x, 10); assert.equal(updated.y, 5);
	view.domNode.querySelector('[contenteditable]')!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	view.pane.editor.selectShape(group.id); pressCanvas(view, 'u');
	const ungrouped = model.value.shapes[0] as typeof label;
	assert.equal(ungrouped.fontSize, 40); assert.equal(ungrouped.lineHeight, 50); assert.equal(ungrouped.textRuns?.[0].style.fontSize, 60); assert.equal(ungrouped.textRuns?.[0].style.letterSpacing, 4);
	model.undo(); assert.equal(model.value.shapes[0].kind, 'group');
});

test('Design font picker queries installed families only on request and accepts a chosen font', async () => {
	using view = createView(); view.layout({ width: 400, height: 300 }); createText(view);
	let calls = 0; const previous = Object.getOwnPropertyDescriptor(globalThis, 'queryLocalFonts');
	Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, value: async () => { calls++; return [{ family: 'Test Serif' }, { family: 'Test Sans' }, { family: 'Test Serif' }]; } });
	try {
		assert.equal(calls, 0);
		const button = [...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Load installed fonts')!; button.click();
		await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(calls, 1);
		const input = view.propertiesDomNode.querySelector<HTMLInputElement>('[aria-label="Font family"]')!; assert.ok(input.list); assert.deepEqual([...input.list.options].map(option => option.value).filter(value => value.startsWith('Test')), ['Test Sans', 'Test Serif']);
		input.value = 'Test Serif'; input.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
		assert.equal((view.designEditors.document.model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>).fontFamily, 'Test Serif');
	} finally { if (previous) { Object.defineProperty(globalThis, 'queryLocalFonts', previous); } else { Reflect.deleteProperty(globalThis, 'queryLocalFonts'); } }
});

test('Linked text styles stay within the character selection and preserve subsequent caret emphasis', () => {
	using view = createView(); view.layout({ width: 400, height: 300 }); createText(view);
	const model = view.designEditors.document.model; const commands = new DocumentCommands(model);
	const original = model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>;
	const styleId = commands.resources.createStyle({ ...original, id: generateUuid(), fontSize: 32, fontWeight: 400, paragraphSpacing: 8 }, 'text', 'Body');
	pressCanvas(view, 'Enter');
	const editor = () => view.domNode.querySelector<HTMLElement>('[contenteditable]')!;
	const input = (text: string) => editor().dispatchEvent(new browser.window.InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
	input('Hello world');
	const select = (start: number, end: number) => {
		editor().focus(); const node = editor().querySelector('span')!.firstChild!; const range = browser.window.document.createRange(); range.setStart(node, start); range.setEnd(node, end);
		const selection = browser.window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); browser.window.document.dispatchEvent(new browser.window.Event('selectionchange'));
	};
	const applyStyle = () => { const control = view.propertiesDomNode.querySelector<HTMLSelectElement>('[aria-label="Text selection style"]')!; control.focus(); control.value = styleId; control.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	select(0, 5); applyStyle();
	let shape = model.value.shapes[0] as typeof original;
	assert.deepEqual(shape.textRuns?.map(run => [run.start, run.end, run.styleId]), [[0, 5, styleId]]);
	assert.equal(shape.textRuns![0].style.fontSize, 32); assert.equal(shape.fontSize, original.fontSize);
	select(5, 5); assert.match(view.pane.editor.getAccessibleContent(), /Text selection 5–5/u, 'selected caret'); applyStyle();
	assert.match(view.pane.editor.getAccessibleContent(), /Text selection 5–5/u, 'style preserves caret');
	// JSDOM collapses DOM selection after focusin; place the browser caret explicitly.
	select(5, 5); editor().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })); input('!');
	shape = model.value.shapes[0] as typeof original;
	assert.equal(shape.text, 'Hello! world');
	const inserted = shape.textRuns!.find(run => run.start === 5)!; assert.equal(inserted.styleId, styleId); assert.equal(inserted.style.fontWeight, 700); assert.ok(inserted.overrides?.includes('fontWeight'));
	commands.resources.updateStyle(styleId, { ...original, fontWeight: 300, fontSize: 40 });
	shape = model.value.shapes[0] as typeof original;
	assert.equal(shape.textRuns!.find(run => run.start === 5)!.style.fontWeight, 700); assert.equal(shape.textRuns!.find(run => run.start === 5)!.style.fontSize, 40);
});

test('IME emoji replacement preserves Unicode boundaries and the surrounding rich text', () => {
	using view = createView(); view.layout({ width: 400, height: 300 }); createText(view);
	const model = view.designEditors.document.model; const commands = new DocumentCommands(model); const id = model.value.shapes[0].id;
	commands.text.replace(id, 0, 4, 'A😀tail'); commands.text.format(id, 3, 7, { fontWeight: 700 }); pressCanvas(view, 'Enter');
	const editor = view.domNode.querySelector<HTMLElement>('[contenteditable]')!;
	editor.dispatchEvent(new browser.window.CompositionEvent('compositionstart', { bubbles: true })); editor.textContent = 'A😃tail'; editor.dispatchEvent(new browser.window.CompositionEvent('compositionend', { bubbles: true, data: '😃' }));
	const shape = model.value.shapes[0] as Extract<DesignShape, { kind: 'text'; }>;
	assert.equal(shape.text, 'A😃tail'); assert.deepEqual(shape.textRuns, [{ start: 3, end: 7, style: { fontWeight: 700 } }]); assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Vector compound paths save, open and recover with editable handles and localized controls', async () => {
	const { designShapeContours } = await import('../../contrib/creator/common/model/designVector.js');
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); const controller = view.designEditors.document;
		const base: DesignShape = { id: generateUuid(), kind: 'rectangle', x: 10, y: 20, width: 200, height: 100, rotation: 30, fill: '#123456' };
		const contour = designShapeContours(base)[0];
		const path: DesignShape = { ...base, kind: 'path', ...contour, strokeWidth: 4, strokeCap: 'round', strokeJoin: 'bevel', dashArray: [12, 4], subpaths: [{ ...contour, nodes: contour.nodes.map(node => ({ ...node, x: node.x / 2, incoming: { x: -1, y: node.y } })) }] };
		controller.model.replace(documentFromShapes([path])); view.pane.editor.selectShape(path.id);
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="控制柄镜像"]')); assert.ok(view.propertiesDomNode.querySelector('[aria-label="描边端点"]'));
		const input = view.propertiesDomNode.querySelector<HTMLSelectElement>('[aria-label="轮廓"]')!; input.value = '1'; input.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
		assert.equal(view.propertiesDomNode.querySelector<HTMLInputElement>('[aria-label="入控制点 X"]')!.value, '-200');
		assert.match(chinese.bundles.ash['sessions.design.vectorHelp'], /原始图层仍可编辑/u);
		view.pane.editor.selectShape(new DocumentCommands(controller.model).addShape('rectangle', { x: 300, y: 300 })); view.pane.editor.selectShapes(controller.model.value.shapes.map(shape => shape.id));
		assert.ok([...view.propertiesDomNode.querySelectorAll('button')].some(button => button.textContent === '联集')); assert.ok([...view.propertiesDomNode.querySelectorAll('button')].some(button => button.textContent === '减去顶层'));
		await controller.saveDocument(); const saved = parseDesignDocument(fileContent); assert.deepEqual(saved, controller.model.value);
		const backup = controller.backup(); controller.model.replace(documentFromShapes([])); controller.restoreBackup(backup); assert.deepEqual(controller.model.value, saved);
		view.pane.editor.selectShape(path.id); await clickAction({ domNode: view.propertiesDomNode }, '转换为矢量网络');
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="网络线段"]')); assert.ok(view.propertiesDomNode.querySelector('[aria-label="填充此区域"]')); assert.ok(view.propertiesDomNode.querySelector('[aria-label="区域颜色"]'));
		await controller.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent), controller.model.value);
		assert.match(chinese.bundles.ash['sessions.design.networkHelp'], /共享节点/u);
		assert.match(chinese.bundles.ash['sessions.design.vectorTopologyHelp'], /Shift\+Delete/u);
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="节点圆角半径"]'));
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="宽度轮廓"]'));
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="圆角平滑度（%）"]'));
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="填充类型"]')); assert.ok(view.propertiesDomNode.querySelector('[aria-label="图层混合模式"]'));
		assert.match(chinese.bundles.ash['sessions.design.paintHelp'], /渐变/u);
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="添加效果"]'));
		assert.match(chinese.bundles.ash['sessions.design.effectsHelp'], /背景模糊/u);
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="描边对齐"]'));
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="端点样式"]'));
		assert.match(chinese.bundles.ash['sessions.design.vectorAppearanceHelp'], /开放端点/u);
		assert.match(chinese.bundles.ash['sessions.design.vectorAppearanceHelp'], /可变宽度工具/u);
		assert.ok([...view.propertiesDomNode.querySelectorAll('button')].some(button => button.textContent === '偏移矢量'));
		assert.ok(view.propertiesDomNode.querySelector('[aria-label="简化程度"]'));
		assert.ok([...view.propertiesDomNode.querySelectorAll('button')].some(button => button.textContent === '简化矢量'));
	} finally { resetNlsResolver(); }
});

test('Gradient properties commit stacks and keyboard edits atomically and persist their SVG appearance', async () => {
	using view = createView(); view.layout({ width: 800, height: 600 });
	const controller = view.designEditors.document, commands = new DocumentCommands(controller.model), id = commands.addShape('rectangle', { x: 100, y: 100 }); view.pane.editor.selectShape(id);
	const select = (label: string, value: string) => { const input = view.propertiesDomNode.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	select('Fill type', 'linear'); assert.equal(controller.model.value.shapes[0].fills?.[0].type, 'linear'); assert.equal(view.domNode.querySelectorAll('linearGradient').length, 1);
	await clickAction({ domNode: view.propertiesDomNode }, 'Add gradient stop'); const before = controller.model.value.shapes[0];
	pressCanvas(view, 'ArrowRight'); const paint = controller.model.value.shapes[0].fills![0]; assert.equal(paint.stops[1].position, .11);
	controller.model.undo(); assert.deepEqual(controller.model.value.shapes[0], before);
	await clickAction({ domNode: view.propertiesDomNode }, 'Duplicate fill'); select('Fill blend mode', 'multiply');
	assert.equal(controller.model.value.shapes[0].fills!.length, 2); assert.equal(controller.model.value.shapes[0].fills![0].blendMode, 'multiply');
	await controller.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent), controller.model.value);
	const backup = controller.backup(); controller.model.replace(documentFromShapes([])); controller.restoreBackup(backup); view.pane.editor.selectShape(id);
	assert.equal(view.domNode.querySelectorAll('linearGradient').length, 2);
	await clickCanvasMenu(view, 'Export SVG'); assert.match(fileContent, /linearGradient/u); assert.match(fileContent, /mix-blend-mode: multiply/u);
	select('Layer blend mode', 'normal'); assert.equal(view.domNode.querySelector<SVGElement>('.ash-sessions-design-shapes > [data-shape-id]')!.style.isolation, 'isolate');
	await clickAction({ domNode: view.propertiesDomNode }, 'Remove fill'); await clickAction({ domNode: view.propertiesDomNode }, 'Remove fill');
	assert.deepEqual(controller.model.value.shapes[0].fills, []); assert.equal(view.domNode.querySelectorAll('[data-paint-id]').length, 0);
});


test('Plus darker containers retain clipped child prototype hotspots and keyboard navigation', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	using view = createView(); const editor = view.pane.editor, model = view.designEditors.document.model, { home, detail } = prototypeScreens();
	const button: DesignShape = { id: generateUuid(), kind: 'rectangle', name: 'Continue', x: 10, y: 20, width: 80, height: 30, rotation: 15, fill: '#c0c0c0', interactions: [{ id: generateUuid(), trigger: 'click', actions: [{ action: 'navigate', destination: detail.id, transition: defaultPrototypeTransition }] }] };
	model.replace(documentFromShapes([{ ...home, blendMode: 'plus-darker', clip: true, children: [button] }, detail]));
	editor.selectShape(home.id); const version = model.version; editor.previewPrototype();
	const scene = view.domNode.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!, hotspot = scene.querySelector<SVGElement>(`[data-shape-id="${button.id}"]`)!;
	assert.equal(hotspot.getAttribute('role'), 'button'); assert.equal(hotspot.getAttribute('tabindex'), '0'); assert.equal(hotspot.parentElement!.getAttribute('overflow'), 'hidden');
	assert.equal(hotspot.getAttribute('transform'), 'rotate(15 50 35)'); assert.equal(hotspot.getAttribute('opacity'), null);
	hotspot.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(scene.dataset.screenId, detail.id); assert.equal(model.version, version);
});

test('Effect properties save complete stacks, reject invalid input and retain one set of interactive layer IDs', async () => {
	using view = createView(); view.layout({ width: 800, height: 600 });
	const controller = view.designEditors.document, commands = new DocumentCommands(controller.model);
	const id = commands.addShape('rectangle', { x: 100, y: 100 }); view.pane.editor.selectShape(id);
	const select = (label: string, value: string) => { const input = view.propertiesDomNode.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	const number = (label: string, value: string) => { const input = view.propertiesDomNode.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new browser.window.Event('change', { bubbles: true })); };
	await clickAction({ domNode: view.propertiesDomNode }, 'Add effect');
	const before = serializeDesignDocument(controller.model.value);
	number('Effect blur', '-1'); assert.equal(serializeDesignDocument(controller.model.value), before);
	number('Effect blur', '12'); number('Shadow spread', '-4');
	await clickAction({ domNode: view.propertiesDomNode }, 'Duplicate effect');
	select('Effect type', 'inner-shadow');
	await clickAction({ domNode: view.propertiesDomNode }, 'Add effect'); select('Effect type', 'layer-blur');
	assert.equal(view.propertiesDomNode.querySelector<HTMLButtonElement>('[aria-label="Duplicate effect"]')!.disabled, true);
	await clickAction({ domNode: view.propertiesDomNode }, 'Add effect'); select('Effect type', 'background-blur');
	const { designEffects } = await import('../../contrib/creator/common/model/designEffects.js');
	const effects = designEffects(controller.model.value.shapes[0]);
	assert.deepEqual(effects.map(effect => effect.type), ['background-blur', 'layer-blur', 'inner-shadow', 'drop-shadow']);
	assert.equal(view.domNode.querySelectorAll(`.ash-sessions-design-shapes [data-shape-id="${id}"]`).length, 1);
	await controller.saveDocument(); assert.deepEqual(parseDesignDocument(fileContent).shapes[0].effects, effects);
	await clickCanvasMenu(view, 'Export SVG');
	assert.match(fileContent, /feGaussianBlur/u); assert.match(fileContent, /shadow-cutout-/u); assert.match(fileContent, /background-mask-/u);
	assert.ok(!fileContent.includes('data-shape-id'));
	const { generateDesignCode } = await import('../../contrib/creator/contrib/code/browser/designCodeGenerator.js');
	assert.match(generateDesignCode(controller.model.value), /layer-blur-/u);
	controller.model.undo(); assert.equal(designEffects(controller.model.value.shapes[0])[0].type, 'drop-shadow');
	controller.model.redo(); assert.deepEqual(designEffects(controller.model.value.shapes[0]), effects);
});

test('Shadow and blur containers preserve nested prototype keyboard hotspots without duplicating them in masks', async () => {
	const { defaultPrototypeTransition } = await import('../../contrib/creator/common/model/prototype.js');
	const { createDesignEffect } = await import('../../contrib/creator/common/model/designEffects.js');
	using view = createView(); const editor = view.pane.editor, model = view.designEditors.document.model, { home, detail } = prototypeScreens();
	const button: DesignShape = { id: generateUuid(), kind: 'rectangle', name: 'Continue', x: 10, y: 20, width: 80, height: 30, rotation: 15, fill: '#ffffff80', effects: [{ id: generateUuid(), type: 'background-blur', blur: 24, progressive: { startBlur: 0, start: { x: 0, y: .5 }, end: { x: 1, y: .5 } } }, createDesignEffect('inner-shadow')], interactions: [{ id: generateUuid(), trigger: 'click', actions: [{ action: 'navigate', destination: detail.id, transition: defaultPrototypeTransition }] }] };
	model.replace(documentFromShapes([{ ...home, clip: true, children: [button], effects: [createDesignEffect('drop-shadow'), { id: generateUuid(), type: 'layer-blur', blur: 8, progressive: { startBlur: 0, start: { x: .5, y: 0 }, end: { x: .5, y: 1 } } }] }, detail]));
	editor.selectShape(home.id); const version = model.version; editor.previewPrototype();
	const scene = view.domNode.querySelector<SVGSVGElement>('.ash-prototype-preview-scene')!;
	assert.equal(scene.querySelectorAll(`[data-shape-id="${button.id}"]`).length, 1);
	const hotspot = scene.querySelector<SVGElement>(`[data-shape-id="${button.id}"]`)!;
	assert.equal(hotspot.getAttribute('role'), 'button'); assert.equal(hotspot.getAttribute('tabindex'), '0');
	hotspot.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(scene.dataset.screenId, detail.id); assert.equal(model.version, version);
});

test('Effect SVG export includes shadows cast by outside strokes and excludes duplicate layer IDs from backdrop images', async () => {
	const { designShapeContours } = await import('../../contrib/creator/common/model/designVector.js');
	const { exportDesignSvg } = await import('../../contrib/creator/browser/svgRenderer.js');
	const { createDesignEffect } = await import('../../contrib/creator/common/model/designEffects.js');
	const base: DesignShape = { id: generateUuid(), kind: 'rectangle', x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: '#ffffff' };
	const path: DesignShape = { ...base, kind: 'path', ...designShapeContours(base)[0], strokeWidth: 20, strokeAlignment: 'outside', effects: [{ id: generateUuid(), type: 'drop-shadow', x: -100, y: 0, blur: 0, color: '#ff0000' }] };
	const glass: DesignShape = { ...base, id: generateUuid(), fill: '#ffffff20', effects: [createDesignEffect('background-blur')] };
	const text = exportDesignSvg(documentFromShapes([path, glass]));
	const svg = new browser.window.DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
	const [left, top, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
	assert.ok(left <= -120 && left + width >= 120 && top <= -20 && top + height >= 120);
	assert.ok(!decodeURIComponent(text).includes('data-shape-id'));
});

test('Progressive blur edits normalized positions with keyboard and cancels a drag inside a rotated scaled group', async () => {
	const { designEffects } = await import('../../contrib/creator/common/model/designEffects.js');
	using view = createView(); view.layout({ width: 800, height: 600 });
	const model = view.designEditors.document.model;
	const effect = { id: generateUuid(), type: 'layer-blur' as const, blur: 24, progressive: { startBlur: 0, start: { x: .5, y: 0 }, end: { x: .5, y: 1 } } };
	const child: DesignShape = { id: generateUuid(), kind: 'rectangle', x: 10, y: 10, width: 100, height: 50, rotation: 0, fill: '#00000080', effects: [effect] };
	const group: DesignShape = { id: generateUuid(), kind: 'group', x: 100, y: 80, width: 240, height: 140, contentWidth: 120, contentHeight: 70, rotation: 90, fill: '#ffffff', children: [child] };
	model.replace(documentFromShapes([group])); view.pane.editor.selectShape(child.id);
	await clickAction({ domNode: view.propertiesDomNode }, 'Edit blur on canvas');
	assert.equal(view.domNode.querySelectorAll('[data-blur-handle]').length, 3);
	const read = () => designEffects(flattenDesignShapes(model.value.shapes).find(shape => shape.id === child.id)!)[0];
	pressCanvas(view, 'ArrowRight');
	assert.deepEqual(read(), { ...effect, progressive: { ...effect.progressive, end: { x: .51, y: 1 } } });
	pressCanvas(view, 'Enter'); pressCanvas(view, 'ArrowUp', { shiftKey: true });
	assert.deepEqual(read(), { ...effect, progressive: { ...effect.progressive, start: { x: .5, y: -.2 }, end: { x: .51, y: 1 } } });
	model.undo(); model.undo(); assert.deepEqual(read(), effect);
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-canvas-viewport')!;
	const begin = (handle = 'end') => view.domNode.querySelector(`[data-blur-handle="${handle}"]`)!.dispatchEvent(new browser.window.PointerEvent('pointerdown', {
		pointerId: 1, button: 0, isPrimary: true, clientX: 170, clientY: 150, bubbles: true
	}));
	const move = () => viewport.dispatchEvent(new browser.window.PointerEvent('pointermove', {
		pointerId: 1, button: 0, isPrimary: true, clientX: 150, clientY: 190, bubbles: true
	}));
	const before = serializeDesignDocument(model.value);
	begin(); move(); assert.equal(serializeDesignDocument(model.value), before);
	pressCanvas(view, 'Escape'); assert.equal(serializeDesignDocument(model.value), before);
	assert.equal(view.domNode.querySelectorAll('[data-blur-handle]').length, 0);
	await clickAction({ domNode: view.propertiesDomNode }, 'Edit blur on canvas');
	begin(); move();
	viewport.dispatchEvent(new browser.window.PointerEvent('pointerup', { pointerId: 1, button: 0, isPrimary: true, clientX: 150, clientY: 190, bubbles: true }));
	assert.deepEqual(read(), { ...effect, progressive: { ...effect.progressive, end: { x: .7, y: 1.2 } } });
	model.undo(); assert.equal(serializeDesignDocument(model.value), before);
	begin('axis'); move();
	viewport.dispatchEvent(new browser.window.PointerEvent('pointerup', { pointerId: 1, button: 0, isPrimary: true, clientX: 150, clientY: 190, bubbles: true }));
	const moved = read();
	assert.ok('progressive' in moved && moved.progressive);
	for (const [actual, expected] of [
		[moved.progressive.start.x, .7], [moved.progressive.start.y, .2],
		[moved.progressive.end.x, .7], [moved.progressive.end.y, 1.2]
	]) { assert.ok(Math.abs(actual - expected) < 1e-12); }
	model.undo(); assert.equal(serializeDesignDocument(model.value), before);
	const invalid = view.propertiesDomNode.querySelector<HTMLInputElement>('[aria-label="Start blur"]')!;
	invalid.value = '-5'; invalid.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(serializeDesignDocument(model.value), before);
	const select = view.propertiesDomNode.querySelector<HTMLSelectElement>('[aria-label="Effect type"]')!;
	select.value = 'background-blur'; select.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.deepEqual(read(), { ...effect, type: 'background-blur' });
	await view.designEditors.document.saveDocument();
	assert.deepEqual(parseDesignDocument(fileContent), model.value);
});

test('Chinese progressive blur fields, descriptions and keyboard help are localized', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const { describeDesignEffect } = await import('../../contrib/creator/browser/designEffectLabels.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView(); view.layout({ width: 400, height: 300 });
		const effect = { id: generateUuid(), type: 'layer-blur' as const, blur: 20, progressive: { startBlur: 0, start: { x: .5, y: 0 }, end: { x: .5, y: 1 } } };
		const shape: DesignShape = { id: generateUuid(), kind: 'rectangle', x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: '#000000', effects: [effect] };
		view.designEditors.document.model.replace(documentFromShapes([shape])); view.pane.editor.selectShape(shape.id);
		for (const label of ['模糊模式', '起点模糊', '终点模糊', '模糊起点 X（%）', '模糊终点 Y（%）', '在画布上编辑模糊']) {
			assert.ok(view.propertiesDomNode.querySelector(`[aria-label="${label}"]`), label);
		}
		assert.match(describeDesignEffect(effect), /渐进式模糊：0 至 20/u);
		assert.match(chinese.bundles.ash['sessions.design.effectsHelp'], /渐进式.*Enter.*Escape/u);
	} finally { resetNlsResolver(); }
});


class AutoSaveFixture extends Disposable {
	readonly storage = this._register(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: generateUuid(), flushInterval: 0 }));
	beforeWrite: ((resource: URI) => Promise<void>) | undefined;
	readonly files: IFileService;
	readonly child = this._register(services.createChild());
	readonly copyResource = URI.file('/design-copy.ash-design');
	confirmations = 0;
	saveDialogs = 0;
	constructor() {
		super();
		const fixture = this;
		const provider = this._register(new class extends InMemoryFileSystemProvider {
			override async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
				await fixture.beforeWrite?.(resource);
				return super.writeFile(resource, bytes, options);
			}
		}());
		this.files = this._register(createTestFileService(provider));
		this.child.registerInstance(IFileService, this.files);
		this.child.registerInstance(IStorageService, this.storage);
		this.child.registerInstance(IFileDialogService, {
			pickFolderAndOpen: async () => { throw new Error('Unexpected folder open'); },
			pickWorkspaceAndOpen: async () => { throw new Error('Unexpected workspace open'); },

			pickFileToSave: unexpected,
			showSaveConfirm: async () => { this.confirmations++; throw new Error('Automatic saving must not ask to save'); },
			showSaveDialog: async () => { this.saveDialogs++; return this.copyResource; },
			showOpenDialog: async () => [this.copyResource],
		});
	}
	createDocument(): InstanceType<typeof DesignDocumentController> { return this._register(this.child.createInstance(DesignDocumentController, CreatorMode.Design)); }
	get activeResource(): URI { return URI.parse(this.storage.get('creator.design.activeDocument', StorageScope.WORKSPACE)!); }
	async readActive(): Promise<ReturnType<typeof parseDesignDocument>> { return parseDesignDocument((await this.files.readFile(URI.joinPath(this.activeResource, 'manifest.json'))).content); }
}

test('Design automatically saves an untitled draft and restores its document and image bytes after reopening', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	const bytes = new Uint8Array([1, 2, 3]);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const asset = { id: generateUuid(), name: 'draft.png', versions: [{ id: generateUuid(), sha256, path: `assets/${sha256}`, mediaType: 'image/png' as const, width: 1, height: 1 }] };
	const image = { id: generateUuid(), kind: 'image' as const, assetId: asset.id, assetVersionId: asset.versions[0].id, crop: { x: 0, y: 0, width: 1, height: 1 }, x: 0, y: 0, width: 1, height: 1, rotation: 0, fill: '#ffffff' };
	document.restoreBackup(JSON.stringify({ manifest: serializeDesignDocument(documentFromShapes([image], document.model.value, [asset])), media: { [sha256]: Buffer.from(bytes).toString('base64') } }));
	const saved = new Promise<void>(resolve => {
		const listener = document.onDidChange(() => { if (!document.isDirty) { listener.dispose(); resolve(); } });
	});
	await saved;
	assert.equal(document.name, 'Untitled design');
	assert.match(fixture.activeResource.path, /creator\/design-test\/[^/]+\.ash-design$/u);
	assert.deepEqual(await fixture.readActive(), document.model.value);
	assert.equal(document.saveStatus, 'All changes saved');
	assert.deepEqual([fixture.confirmations, fixture.saveDialogs], [0, 0]);
	const original = document.model.value;
	document.dispose();
	const restored = fixture.createDocument();
	await restored.ready;
	assert.deepEqual(restored.model.value, original);
	assert.deepEqual(restored.readMedia(asset.versions[0]), bytes);
	assert.equal(restored.isDirty, false);
	assert.equal(restored.name, 'Untitled design');
	new DocumentCommands(restored.model).addShape('rectangle', { x: 10, y: 20 });
	assert.equal(await restored.flushAutoSave(), true);
	assert.equal((await fixture.readActive()).shapes.length, 2);
});

test('Design drains edits made during saving without interrupting editing or asking for a path', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	let writes = 0;
	fixture.beforeWrite = async () => { if (++writes === 1) { enter(); await gate; } };
	const saving = document.flushAutoSave();
	await entered;
	assert.equal(document.isBusy, false);
	new DocumentCommands(document.model).addShape('ellipse', { x: 30, y: 40 });
	const closing = document.confirmDiscard();
	release();
	assert.deepEqual(await Promise.all([saving, closing]), [true, false]);
	assert.deepEqual(await fixture.readActive(), document.model.value);
	assert.equal(writes, 2);
	assert.equal(document.isDirty, false);
	assert.deepEqual([fixture.confirmations, fixture.saveDialogs], [0, 0]);
});

test('Design retains failed edits, refuses to close on failure and retries without a save dialog', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	using editor = fixture.child.createInstance(DesignEditorWidget, browser.window.document, document, (context: DesignEditorContributionContext) => createDesignEditorContributions(context, fixture.child));
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	fixture.beforeWrite = async () => { throw new Error('Disk full'); };
	assert.equal(await document.flushAutoSave(), false);
	assert.equal(await document.confirmDiscard(), true);
	assert.equal(document.needsSaveRetry, true);
	assert.ok(notifications.getNotifications().some(notification => notification.message === document.saveStatus));
	assert.equal(document.isDirty, true);
	assert.equal(document.model.value.shapes.length, 1);
	fixture.beforeWrite = undefined;
	assert.equal(await document.flushAutoSave(), true);
	assert.equal(document.needsSaveRetry, false);
	assert.equal(document.isDirty, false);
	assert.deepEqual([fixture.confirmations, fixture.saveDialogs], [0, 0]);
});

test('Design autosave preserves an externally changed package instead of overwriting it', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	await document.flushAutoSave();
	const manifest = URI.joinPath(fixture.activeResource, 'manifest.json');
	const external = serializeDesignDocument(documentFromShapes([], document.model.value));
	await fixture.files.writeFile({ resource: manifest, content: external });
	new DocumentCommands(document.model).addShape('ellipse', { x: 0, y: 0 });
	assert.equal(await document.flushAutoSave(), false);
	assert.equal((await fixture.files.readFile(manifest)).content, external);
	assert.equal(document.model.value.shapes.length, 2);
	assert.equal(document.isDirty, true);
	assert.equal(await document.confirmDiscard(), true);
	assert.equal(fixture.confirmations, 0);
});

test('Design save a copy and export stay manual and keep the automatically saved document active', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	await document.flushAutoSave();
	const active = fixture.activeResource;
	const original = document.model.value;
	assert.equal(fixture.saveDialogs, 0);
	await document.saveCopy();
	const copy = parseDesignDocument((await fixture.files.readFile(URI.joinPath(fixture.copyResource, 'manifest.json'))).content);
	assert.notEqual(copy.documentId, original.documentId);
	assert.deepEqual(copy.shapes, original.shapes);
	assert.deepEqual(document.model.value, original);
	assert.equal(fixture.activeResource.toString(), active.toString());
	await document.exportDocument({ title: 'Export SVG', filename: 'design.svg', extension: 'svg', content: '<svg />' });
	assert.equal(fixture.saveDialogs, 2);
	assert.equal(document.isDirty, false);
	assert.deepEqual(await fixture.readActive(), original);
});

test('Design failed restoration keeps the original pointer and blocks replacement until retry succeeds', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	await document.flushAutoSave();
	const resource = fixture.activeResource;
	const manifest = URI.joinPath(resource, 'manifest.json');
	const original = await fixture.files.readFile(manifest);
	document.dispose();
	await fixture.files.writeFile({ resource: manifest, content: '{broken' });
	const restored = fixture.createDocument();
	await restored.ready;
	assert.equal(restored.needsSaveRetry, true);
	assert.equal(await restored.confirmDiscard(), true);
	assert.equal(fixture.activeResource.toString(), resource.toString());
	assert.equal((await fixture.files.readFile(manifest)).content, '{broken');
	await fixture.files.writeFile({ resource: manifest, content: original.content });
	assert.equal(await restored.flushAutoSave(), true);
	assert.equal(restored.needsSaveRetry, false);
	assert.deepEqual(restored.model.value, parseDesignDocument(original.content));
});

test('Design autosave status and copy actions use Chinese localization', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using fixture = new AutoSaveFixture();
		const document = fixture.createDocument();
		new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
		assert.equal(document.saveStatus, '正在保存…');
		await document.flushAutoSave();
		assert.equal(document.saveStatus, '所有更改已保存');
		using view = createView();
		assert.match(view.pane.editor.getAccessibleContent(), /所有更改已保存/u);
	} finally { resetNlsResolver(); }
});


test('Design close drains edits from final lifecycle joins without confirming save', async () => {
	using fixture = new AutoSaveFixture();
	using lifecycle = new class extends AbstractLifecycleService { }(StartupKind.NewWindow, new NullLoggerService(), fixture.storage);
	fixture.child.registerInstance(ILifecycleService, lifecycle);
	using editors = fixture.child.createInstance(DesignEditorService);
	const document = editors.document;
	const commands = new DocumentCommands(document.model);
	commands.addShape('rectangle', { x: 0, y: 0 });
	// A later shutdown participant can still commit an edit after the initial flush.
	using lateEdit = lifecycle.onWillShutdown(event => event.join(Promise.resolve().then(() => { commands.addShape('ellipse', { x: 10, y: 20 }); }), 'Finish pending edit'));
	await lifecycle.shutdown('windowClose');
	assert.equal(document.isDirty, false);
	assert.deepEqual(await fixture.readActive(), document.model.value);
	assert.equal(document.model.value.shapes.length, 2);
	assert.equal(fixture.confirmations, 0);
});

test('Design publishes a library only when explicitly requested', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	await document.flushAutoSave();
	assert.equal(fixture.saveDialogs, 0);
	await fixture.files.createDirectory(URI.file('/'));
	await document.publishLibrary();
	assert.equal(fixture.saveDialogs, 1);
	const published = JSON.parse((await fixture.files.readFile(fixture.copyResource)).content);
	assert.equal(published.kind, 'ash-design-library');
	assert.equal(published.document.documentId, document.model.value.documentId);
	assert.deepEqual(await fixture.readActive(), document.model.value);
});

test('Design save a copy rejects the active package as its destination', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	await document.saveDocument(fixture.copyResource);
	const original = await fixture.readActive();
	await document.saveCopy();
	assert.deepEqual(await fixture.readActive(), original);
	assert.deepEqual(document.model.value, original);
});

test('Page and fill color widgets preserve alpha, validate edits and restore their shared document history', async () => {
	using fixture = new AutoSaveFixture();
	const document = fixture.createDocument();
	using editor = fixture.child.createInstance(DesignEditorWidget, browser.window.document, document, (context: DesignEditorContributionContext) => createDesignEditorContributions(context, fixture.child));
	editor.initialize();
	const properties = editor.propertiesDomNode;
	const field = (label: string): HTMLInputElement => properties.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
	const change = (label: string, value: string): void => { const input = field(label); input.value = value; input.dispatchEvent(new browser.window.Event('change')); };
	assert.equal(properties.querySelector('.ash-design-page-name, .ash-design-page-summary'), null);
	assert.equal(field('Page background color').value, 'FFFFFF');
	change('Page background color', '112233');
	change('Page background opacity (%)', '25');
	assert.equal(document.model.value.background, '#11223340');
	document.model.undo();
	assert.equal(document.model.value.background, '#112233');
	document.model.undo();
	assert.equal(document.model.value.background, undefined);
	document.model.redo(); document.model.redo();
	const version = document.model.version;
	change('Page background color', 'invalid');
	change('Page background opacity (%)', '101');
	assert.equal(document.model.version, version);
	assert.equal(field('Page background color').getAttribute('aria-invalid'), 'true');
	assert.equal(field('Page background opacity (%)').getAttribute('aria-invalid'), 'true');
	change('Page background color', 'ABCDEF');
	assert.equal(document.model.value.background, '#abcdef40');
	const id = new DocumentCommands(document.model).addShape('rectangle', { x: 0, y: 0 });
	editor.selectShape(id);
	change('Fill color', 'AABBCC');
	change('Fill opacity (%)', '40');
	assert.equal(document.model.value.shapes[0].fill, '#aabbcc66');
	assert.equal(document.model.value.background, '#abcdef40');
	assert.equal(await document.flushAutoSave(), true);
	using restored = fixture.createDocument();
	await restored.ready;
	assert.equal(restored.model.value.background, '#abcdef40');
	assert.equal(restored.model.value.shapes[0].fill, '#aabbcc66');
	const serialized = JSON.parse(serializeDesignDocument(restored.model.value));
	serialized.artifacts[restored.model.value.artifactId].background = 'url(untrusted)';
	assert.throws(() => parseDesignDocument(JSON.stringify(serialized)), /Invalid design composition/u);
});

test('Stroke and both shadow types share color controls, keep alpha and close pickers on selection changes', () => {
	using view = createView();
	const editor = DesignEditorWidget.getFocused(view.domNode)!;
	const model = editor.documentController.model;
	const commands = new DocumentCommands(model);
	const pathId = commands.addShape('path', { x: 0, y: 0 }); editor.selectShape(pathId);
	const field = (label: string): HTMLInputElement => view.propertiesDomNode.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
	const change = (label: string, value: string): void => { const input = field(label); input.value = value; input.dispatchEvent(new browser.window.Event('change')); };
	const button = (label: string): HTMLButtonElement => [...view.propertiesDomNode.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)!;
	change('Stroke color', '336699'); change('Stroke opacity (%)', '40');
	assert.equal((model.value.shapes[0] as Extract<DesignShape, { kind: 'path'; }>).stroke, '#33669966');
	editor.undo(); assert.equal((model.value.shapes[0] as Extract<DesignShape, { kind: 'path'; }>).stroke, '#336699');
	editor.redo(); button('Use fill color for stroke').click();
	assert.equal((model.value.shapes[0] as Extract<DesignShape, { kind: 'path'; }>).stroke, undefined);
	button('Stroke color').click(); assert.ok(browser.window.document.querySelector('.ash-color-picker'));
	pressCanvas(view, 'r'); assert.equal(browser.window.document.querySelector('.ash-color-picker'), null);
	button('Add effect').click();
	for (const type of ['drop-shadow', 'inner-shadow']) {
		const select = view.propertiesDomNode.querySelector<HTMLSelectElement>('select[aria-label="Effect type"]')!;
		select.value = type; select.dispatchEvent(new browser.window.Event('change'));
		change('Shadow color', '123456'); change('Shadow opacity (%)', '40');
		const effects = model.value.shapes[1].effects; assert.ok(Array.isArray(effects));
		assert.equal(effects[0].color, '#12345666');
		assert.ok(field('Shadow color').closest('.ash-color-picker-input'));
		button('Choose shadow color').click(); assert.ok(browser.window.document.querySelector('.ash-color-picker'));
		editor.setVisible(false); assert.equal(browser.window.document.querySelector('.ash-color-picker'), null);
		editor.setVisible(true);
	}
});
