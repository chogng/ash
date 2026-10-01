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
import { DesignConfiguration } from '../../contrib/design/common/designConfiguration.js';

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
services.registerInstance(IContextKeyService, contextKeys);
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IThemeService, theme);
suiteTeardown(() => {
	services.dispose();
	contextKeys.dispose();
	configuration.dispose();
	theme.dispose();
	browser.window.close();
});

interface ProjectedTransform { panX: number; panY: number; scale: number; }

function createView(): InstanceType<typeof DesignCanvasView> {
	const view = services.createInstance(DesignCanvasView, browser.window.document);
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
