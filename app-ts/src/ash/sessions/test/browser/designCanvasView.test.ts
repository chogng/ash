import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../base/browser/dom.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { DesignConfiguration } from '../../contrib/design/common/designConfiguration.js';
import { Event as AshEvent } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { FileKind, FileRevisionConflictError, IFileService, type IFileWriteRequest } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../workbench/services/lifecycle/common/lifecycle.js';


const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
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

const { DesignCanvasView } = await import('../../contrib/design/browser/designCanvasView.js');
const services = new InstantiationService();
const contextKeys = new ContextKeyService();
const configuration = new WorkbenchConfigurationService();
const theme = new TestThemeService(lightColorTheme);
const workspace = new WorkspaceContextService({ id: 'design-test', folders: [] });
services.registerInstance(IContextKeyService, contextKeys);
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IThemeService, theme);
services.registerInstance(IWorkspaceContextService, workspace);
const resource = URI.file('/design.ash-design.json');
let fileContent = '';
let revision = '0';
let errors: string[] = [];
let saveDecision = ConfirmResult.DONT_SAVE;
const writes: IFileWriteRequest[] = [];
const unexpected = async (): Promise<never> => { throw new Error('Unexpected service call'); };
services.registerInstance(IContextMenuService, { onDidShowContextMenu: AshEvent.None, onDidHideContextMenu: AshEvent.None, showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu: () => {} });
services.registerInstance(IFileDialogService, { pickFileToSave: unexpected, showSaveConfirm: async () => saveDecision, showSaveDialog: async () => resource, showOpenDialog: async () => [resource] });
services.registerInstance(IDialogService, { onWillShowDialog: AshEvent.None, onDidShowDialog: AshEvent.None, showMessage: unexpected, info: unexpected, warn: unexpected, error: async message => { errors.push(message); }, confirm: unexpected, prompt: unexpected, input: unexpected, about: unexpected });
services.registerInstance(IFileService, {
	onDidChangeFiles: AshEvent.None,
	stat: unexpected, readDirectory: unexpected, readFileBytes: unexpected, writeFileBytes: unexpected, createFile: unexpected, createDirectory: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
	readFile: async () => ({ resource, content: fileContent, revision }),
	writeFile: async request => {
		writes.push(request);
		if (request.expectedRevision !== undefined && request.expectedRevision !== revision) { throw new FileRevisionConflictError(resource); }
		fileContent = request.content;
		revision = `${Number(revision) + 1}`;
		return { revision, stat: { resource, kind: FileKind.File, sizeBytes: fileContent.length, readonly: false, modifiedAtMillis: undefined } };
	},
});
services.registerInstance(ILifecycleService, { startupKind: StartupKind.NewWindow, phase: LifecyclePhase.Ready, willShutdown: false, onBeforeShutdown: AshEvent.None, onBeforeShutdownError: AshEvent.None, onShutdownVeto: AshEvent.None, onWillShutdown: AshEvent.None, onDidShutdown: AshEvent.None, when: async () => {}, shutdown: async () => {} });

suiteTeardown(() => {
	services.dispose();
	contextKeys.dispose();
	configuration.dispose();
	theme.dispose();
	workspace.dispose();
	browser.window.close();
});

interface ProjectedTransform { panX: number; panY: number; scale: number; }

function createView(): InstanceType<typeof DesignCanvasView> {
	const view = services.createInstance(DesignCanvasView, browser.window.document.body);
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
	let captured: number | undefined;
	viewport.setPointerCapture = id => { captured = id; };
	viewport.hasPointerCapture = id => captured === id;
	viewport.releasePointerCapture = () => { captured = undefined; };
	Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
	browser.window.document.body.append(view.domNode);
	return view;
}

function projectedTransform(view: InstanceType<typeof DesignCanvasView>): ProjectedTransform {
	const transform = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-world')!.style.transform;
	const match = transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)!;
	return { panX: Number(match[1]), panY: Number(match[2]), scale: Number(match[3]) };
}

function dispatchWheel(view: InstanceType<typeof DesignCanvasView>, init: WheelEventInit & { clientX?: number; clientY?: number }): void {
	view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!
		.dispatchEvent(new browser.window.WheelEvent('wheel', { cancelable: true, ...init }));
}

test('Design canvas derives its document and focus from the host in another window', () => {
	const otherWindow = new JSDOM('<!doctype html><body></body>', { url: 'https://other.ash.test' });
	try {
		const container = h(otherWindow.window.document, 'div');
		otherWindow.window.document.body.append(container);
		using view = services.createInstance(DesignCanvasView, container);
		container.append(view.domNode);
		assert.equal(view.domNode.ownerDocument, container.ownerDocument);
		assert.notEqual(view.domNode.ownerDocument, document);
		view.focus();
		assert.equal(container.ownerDocument.activeElement, view.domNode);
		view.domNode.dispatchEvent(new otherWindow.window.KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
		view.domNode.dispatchEvent(new otherWindow.window.KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
		const shapeElements = Array.from(view.domNode.querySelectorAll('svg, svg > *'));
		assert.equal(shapeElements.length, 4);
		for (const element of shapeElements) {
			assert.equal(element.ownerDocument, container.ownerDocument);
			assert.ok(element instanceof otherWindow.window.SVGElement);
		}
	} finally {
		otherWindow.window.close();
	}
});

test('Design cursor follows configuration and theme changes and releases its subscriptions', async () => {
	const view = createView();
	const cursor = () => view.domNode.style.getPropertyValue('--ash-sessions-design-pointer-cursor');
	try {
		assert.equal(view.domNode.classList.contains('pointer-cursor'), true);
		assert.match(decodeURIComponent(cursor()), /width="24" height="24"/u);
		const initialCursor = cursor();
		theme.setColorTheme(darkColorTheme);
		assert.notEqual(cursor(), initialCursor);
		await configuration.updateValue(DesignConfiguration.usePointerCursor, false);
		assert.equal(view.domNode.classList.contains('pointer-cursor'), false);
		assert.equal(configuration.inspect(DesignConfiguration.usePointerCursor).userValue, false);
		using nextView = createView();
		assert.equal(nextView.domNode.classList.contains('pointer-cursor'), false);
		await assert.rejects(configuration.updateValue(DesignConfiguration.usePointerCursor, 'false'), /must be boolean/u);
		await assert.rejects(configuration.updateValue(DesignConfiguration.usePointerCursor, false, ConfigurationTarget.WORKSPACE), /Unable to write/u);
		view.dispose();
		const disposedCursor = cursor();
		await configuration.updateValue(DesignConfiguration.usePointerCursor, true);
		theme.setColorTheme(lightColorTheme);
		assert.equal(view.domNode.classList.contains('pointer-cursor'), false);
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
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
	const firePointer = (type: string, x: number, y: number): void => {
		viewport.dispatchEvent(new browser.window.PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
	};
	try {
		firePointer('pointerdown', 10, 10);
		assert.ok(view.domNode.classList.contains('panning'));
		firePointer('pointermove', 40, 25);
		firePointer('pointerup', 40, 25);
		assert.deepEqual(projectedTransform(view), { panX: 30, panY: 15, scale: 1 });
		assert.ok(!view.domNode.classList.contains('panning'));
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

function pressCanvas(view: InstanceType<typeof DesignCanvasView>, key: string, options: KeyboardEventInit = {}): void {
	view.domNode.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...options }));
}

async function clickAction(view: InstanceType<typeof DesignCanvasView>, name: string): Promise<void> {
	const button = Array.from(view.domNode.querySelectorAll('button')).find(button => button.textContent === name)!;
	button.click();
	// File-service promises are immediate in this fixture, but the action crosses several async boundaries.
	for (let index = 0; index < 20; index++) { await Promise.resolve(); }
}

test('Design edits render fractional geometry, keep input editing separate and undo a whole drag', () => {
	using view = createView();
	view.layout({ width: 200, height: 100 });
	pressCanvas(view, 'r');
	const rect = view.domNode.querySelector<SVGRectElement>('[data-shape-id]')!;
	const width = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
	width.value = '120.5';
	width.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	width.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
	assert.equal(rect.getAttribute('width'), '120.5');
	pressCanvas(view, '+');
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
	const fire = (type: string, x: number): void => { viewport.dispatchEvent(new browser.window.PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 50, bubbles: true })); };
	const before = Number(rect.getAttribute('x'));
	fire('pointerdown', 100);
	fire('pointermove', 124);
	fire('pointermove', 148);
	fire('pointerup', 148);
	assert.equal(Number(rect.getAttribute('x')), before + 40);
	view.undo();
	assert.equal(Number(rect.getAttribute('x')), before);
	view.redo();
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
	await clickAction(view, 'Save design');
	const saved = fileContent;
	assert.equal(view.domNode.classList.contains('dirty'), false);
	pressCanvas(view, 'e');
	await clickAction(view, 'Open design');
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 1);
	assert.equal(JSON.parse(saved).shapes[0].kind, 'rectangle');
	pressCanvas(view, 'Tab');
	pressCanvas(view, 'ArrowRight');
	revision = '99';
	await clickAction(view, 'Save design');
	assert.equal(writes.at(-1)!.expectedRevision, '1');
	assert.equal(view.domNode.classList.contains('dirty'), true);
	assert.equal(fileContent, saved);
	assert.equal(errors.length, 1);
	fileContent = '{"version":1,"shapes":[{"kind":"rectangle"}]}';
	await clickAction(view, 'Open design');
	assert.equal(view.domNode.querySelectorAll('[data-shape-id]').length, 1);
	assert.equal(view.domNode.classList.contains('dirty'), true);
	assert.equal(errors.length, 2);
	saveDecision = ConfirmResult.CANCEL;
	await clickAction(view, 'Open design');
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
		assert.equal(view.domNode.querySelector('input[aria-label="宽度"]') !== null, true);
		assert.match(DesignCanvasView.getFocused(view.domNode)!.getAccessibleContent(), /矩形[\s\S]*椭圆/u);
		pressCanvas(view, 'Delete');
		assert.equal(view.domNode.querySelector('[data-shape-id]')!.tagName, 'ellipse');
	} finally { resetNlsResolver(); }
});
