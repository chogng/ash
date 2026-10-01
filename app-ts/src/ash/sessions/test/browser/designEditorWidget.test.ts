import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { DesignConfiguration } from '../../contrib/design/common/config/editorConfiguration.js';
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

const { DesignEditorWidget } = await import('../../contrib/design/browser/widget/designEditorWidget.js');
const { DesignDocumentController } = await import('../../contrib/design/browser/designDocumentController.js');
const { DesignEditorPage } = await import('../../contrib/design/browser/designEditorPage.js');
const { createDesignEditorContributions } = await import('../../contrib/design/design.main.js');
const services = new InstantiationService();
const contextKeys = new ContextKeyService();
const configuration = new WorkbenchConfigurationService();
const theme = new TestThemeService(lightColorTheme);
services.registerInstance(IContextKeyService, contextKeys);
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IThemeService, theme);
services.registerInstance(IWorkspaceContextService, new WorkspaceContextService({ id: 'design-test', folders: [] }));
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
	browser.window.close();
});

interface ProjectedTransform { panX: number; panY: number; scale: number; }

function createView(): InstanceType<typeof DesignEditorPage> {
	const view = services.createInstance(DesignEditorPage, browser.window.document);
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
	let captured: number | undefined;
	viewport.setPointerCapture = id => { captured = id; };
	viewport.hasPointerCapture = id => captured === id;
	viewport.releasePointerCapture = () => { captured = undefined; };
	Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
	browser.window.document.body.append(view.domNode);
	return view;
}

function projectedTransform(view: { readonly domNode: HTMLElement }): ProjectedTransform {
	const transform = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-world')!.style.transform;
	const match = transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)!;
	return { panX: Number(match[1]), panY: Number(match[2]), scale: Number(match[3]) };
}

function dispatchWheel(view: { readonly domNode: HTMLElement }, init: WheelEventInit & { clientX?: number; clientY?: number }): void {
	view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!
		.dispatchEvent(new browser.window.WheelEvent('wheel', { cancelable: true, ...init }));
}

test('Design cursor follows configuration and theme changes and releases its subscriptions', async () => {
	const view = createView();
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
	const cursor = () => viewport.style.getPropertyValue('--ash-sessions-design-pointer-cursor');
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
		assert.equal(nextView.domNode.querySelector('.ash-sessions-design-viewport')!.classList.contains('pointer-cursor'), false);
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
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
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

function pressCanvas(view: { readonly domNode: HTMLElement }, key: string, options: KeyboardEventInit = {}): void {
	view.domNode.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...options }));
}

async function clickAction(view: { readonly domNode: HTMLElement }, name: string): Promise<void> {
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
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /矩形[\s\S]*椭圆/u);
		pressCanvas(view, 'Delete');
		assert.equal(view.domNode.querySelector('[data-shape-id]')!.tagName, 'ellipse');
	} finally { resetNlsResolver(); }
});

test('Design edits text and path nodes, groups a selection, and exports safe SVG without changing save state', async () => {
	using view = createView();
	view.layout({ width: 400, height: 300 });
	pressCanvas(view, 't');
	const text = view.domNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text content"]')!;
	text.value = '中文 <script>alert(1)</script>\nSecond line';
	text.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /中文 <script>/u);
	assert.equal(view.domNode.querySelector('script'), null);
	assert.equal(view.domNode.querySelectorAll('tspan').length, 2);
	pressCanvas(view, 'p');
	const outgoing = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Outgoing handle X"]')!;
	outgoing.value = '48';
	outgoing.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.match(view.domNode.querySelector('path[data-shape-id]')!.getAttribute('d')!, /C 188 10/u);
	await clickAction(view, 'Add node');
	assert.equal(view.domNode.querySelector<HTMLSelectElement>('select[aria-label="Path node"]')!.options.length, 3);
	await clickAction(view, 'Remove node');
	const closed = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Closed path"]')!;
	closed.click();
	assert.match(view.domNode.querySelector('path[data-shape-id]')!.getAttribute('d')!, / Z$/u);
	pressCanvas(view, 'n');
	pressCanvas(view, 'g');
	assert.equal(view.domNode.querySelectorAll('svg[data-shape-id] > [data-shape-id]').length, 2);
	const width = view.domNode.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
	width.value = '480';
	width.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
	assert.equal(view.domNode.querySelector('input[aria-label="Height"]')!.getAttribute('type'), 'number');
	await DesignEditorWidget.getFocused(view.domNode)!.saveDocument();
	const saved = fileContent;
	pressCanvas(view, 'ArrowRight');
	await clickAction(view, 'Export SVG');
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
	await clickAction(view, 'Open design');
	pressCanvas(view, 'Tab');
	pressCanvas(view, 'u');
	assert.equal(view.domNode.querySelectorAll('.ash-sessions-design-shapes > [data-shape-id]').length, 2);
	DesignEditorWidget.getFocused(view.domNode)!.undo();
	assert.equal(view.domNode.querySelectorAll('.ash-sessions-design-shapes > [data-shape-id]').length, 1);
});

test('Chinese Design actions and new property labels are localized', async () => {
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using view = createView();
		pressCanvas(view, 't');
		assert.equal(view.domNode.querySelector('.ash-sessions-design-properties textarea')!.getAttribute('aria-label'), '文字内容');
		pressCanvas(view, 'p');
		assert.ok(view.domNode.querySelector('input[aria-label="出控制点 X"]'));
		assert.ok(Array.from(view.domNode.querySelectorAll('button')).some(button => button.textContent === '导出 SVG'));
		pressCanvas(view, 'n');
		pressCanvas(view, 'g');
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /组合[\s\S]*文字[\s\S]*贝塞尔路径/u);
	} finally { resetNlsResolver(); }
});

test('Design editors share document edits and history while keeping selection, camera and lifetime separate', () => {
	using document = services.createInstance(DesignDocumentController);
	using first = services.createInstance(DesignEditorWidget, browser.window.document, document, createDesignEditorContributions);
	using second = services.createInstance(DesignEditorWidget, browser.window.document, document, createDesignEditorContributions);
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
	assert.equal(first.domNode.querySelectorAll('[data-shape-id]').length, 1);
});

test('Sessions page owns the unsaved browser-close check and releases it with the page', () => {
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
	const viewport = view.domNode.querySelector<HTMLElement>('.ash-sessions-design-viewport')!;
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
	tools.querySelector<HTMLButtonElement>('button[aria-label="Move canvas (H)"]')!.click();
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
	assert.equal(view.domNode.querySelector('.ash-sessions-design-selection rect')!.getAttribute('x'), '190');
	assert.equal(view.domNode.querySelector('.ash-sessions-design-selection')!.classList.contains('visible'), true);
	await clickAction(view, 'Add keyframe');
	assert.equal(view.domNode.querySelector<HTMLSelectElement>('select[aria-label="Keyframe"]')!.options.length, 3);
	await DesignEditorWidget.getFocused(view.domNode)!.saveDocument();
	const saved = fileContent;
	assert.equal(JSON.parse(saved).shapes[0].motion.keyframes.length, 3);
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
	await clickAction(view, 'Open design');
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
		assert.ok(view.domNode.querySelector('button[aria-label="移动画布（H）"]'));
		pressCanvas(view, 't');
		const text = view.domNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="文字内容"]')!;
		text.value = '</script><script>alert(1)</script> 中文';
		text.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
		await clickAction(view, '动效');
		await clickAction(view, '添加关键帧');
		assert.ok(view.domNode.querySelector('input[aria-label="关键帧透明度"]'));
		await clickAction(view, '代码');
		const source = view.domNode.querySelector<HTMLTextAreaElement>('textarea[aria-label="生成的代码"]')!.value;
		const html = new browser.window.DOMParser().parseFromString(source, 'text/html');
		assert.equal(html.querySelectorAll('script').length, 1);
		assert.equal(JSON.parse(html.querySelector('script')!.textContent!).shapes[0].text, text.value);
		assert.match(DesignEditorWidget.getFocused(view.domNode)!.getAccessibleContent(), /doctype html/u);
	} finally { resetNlsResolver(); }
});
