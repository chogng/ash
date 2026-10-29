import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../base/common/event.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { validatePartsSplash, IThemeService, type IPartsSplash } from '../../../../../platform/theme/common/themeService.js';
import { createColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase, type IWillShutdownEvent } from '../../../../services/lifecycle/common/lifecycle.js';
import { PartsSplash } from '../../browser/partsSplash.js';
import { ISplashStorageService, browserSplashStorageKey, readBrowserPartsSplash, showPartsSplash } from '../../browser/splash.js';
import { showStartupError } from '../../../../browser/startupError.js';
import '../../../../common/theme.js';

const cached: IPartsSplash = { baseTheme: ColorScheme.Dark, colorInfo: { background: '#123456', foreground: '#ffffff' } };
const drawing = {
	left: 0, top: 0, width: 300, height: 700, background: '#abcdef',
	borderRadii: [[6, 8], [0, 0], [0, 0], [12, 10]],
	borders: [
		{ width: 0, color: '#abcdef', style: 'none' },
		{ width: 1, color: '#ffffff', style: 'solid' },
		{ width: 0, color: '#abcdef', style: 'none' },
		{ width: 0, color: '#abcdef', style: 'none' },
	],
} as const;

function createDom(): JSDOM {
	const dom = new JSDOM('<!doctype html><html><head></head><body><main id="app"></main></body></html>', { url: 'https://ash.test/browser/workbench/workbench.html' });
	Object.defineProperty(dom.window.performance, 'mark', { value: () => undefined });
	Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: query.includes('dark') }) });
	return dom;
}

test('startup cache validates CSS and falls back when storage is corrupt or inaccessible', () => {
	const dom = createDom();
	try {
		const ownerWindow = dom.window as unknown as Window;
		const key = browserSplashStorageKey(ownerWindow);
		ownerWindow.localStorage.setItem(key, JSON.stringify(cached));
		assert.deepEqual(readBrowserPartsSplash(ownerWindow), cached);
		ownerWindow.localStorage.setItem(key, '{broken');
		assert.equal(readBrowserPartsSplash(ownerWindow).colorInfo.background, '#1e1e1e');
		assert.throws(() => validatePartsSplash({ ...cached, colorInfo: { ...cached.colorInfo, background: 'url(secret)' } }), /colors/);
		assert.throws(() => validatePartsSplash({ ...cached, baseTheme: 'unknown' }), /splash/);
		Object.defineProperty(dom.window, 'localStorage', { get: () => { throw new Error('Storage denied'); } });
		assert.equal(readBrowserPartsSplash(ownerWindow).colorInfo.background, '#1e1e1e');
	} finally { dom.window.close(); }
});

test('the production capture receives layout and theme events and releases all listeners', async () => {
	const dom = createDom();
	try {
		const ownerDocument = dom.window.document;
		showPartsSplash(ownerDocument, cached);
		using layoutChanged = new Emitter<{ width: number; height: number; }>();
		using shutdown = new Emitter<IWillShutdownEvent>();
		using themes = new TestThemeService(createColorTheme({ id: 'splash-test', label: 'Test', colorScheme: ColorScheme.Light, colorOverrides: { 'workbench.background': '#abcdef', 'titleBar.background': '#987654' } }));
		using services = new InstantiationService();
		let phase = LifecyclePhase.Starting;
		let restored!: () => void;
		const restoration = new Promise<void>(resolve => { restored = resolve; });
		const saved: IPartsSplash[] = [];
		services.registerInstance(IThemeService, themes);
		services.registerInstance(ILayoutService, { mainContainer: ownerDocument.getElementById('app')!, onDidLayoutMainContainer: layoutChanged.event } as ILayoutService);
		services.registerInstance(ILifecycleService, { get phase() { return phase; }, when: () => restoration, onWillShutdown: shutdown.event } as unknown as ILifecycleService);
		services.registerInstance(ISplashStorageService, { saveWindowSplash: async splash => { saved.push(splash); } });
		const capture = services.createInstance(PartsSplash);
		layoutChanged.fire({ width: 0, height: 0 });
		assert.ok(ownerDocument.getElementById('ash-parts-splash'));
		layoutChanged.fire({ width: 1200, height: 800 });
		assert.equal(ownerDocument.getElementById('ash-parts-splash'), null);
		assert.equal(ownerDocument.querySelector('.ash-initial-shell-colors'), null);
		assert.deepEqual(saved, []);
		phase = LifecyclePhase.Restored;
		restored();
		await restoration;
		assert.deepEqual(saved, [{ baseTheme: ColorScheme.Light, colorInfo: { background: '#abcdef', foreground: '#3b3b3b' } }]);
		themes.setColorTheme(createColorTheme({ id: 'splash-before-shutdown', label: 'Shutdown', colorScheme: ColorScheme.Dark }));
		const joins: Promise<unknown>[] = [];
		shutdown.fire({ reason: 'quit', join: operation => { if (typeof operation !== 'function') joins.push(operation); } });
		await Promise.all(joins);
		assert.equal(joins.length, 1);
		assert.equal((saved as readonly IPartsSplash[]).at(-1)!.baseTheme, ColorScheme.Dark);
		capture.dispose();
		themes.setColorTheme(createColorTheme({ id: 'splash-after-dispose', label: 'Disposed', colorScheme: ColorScheme.Dark }));
		assert.equal(saved.length, 2);
	} finally { dom.window.close(); }
});

test('startup error removes the decorative splash before focusing its retry action', () => {
	const dom = createDom();
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalError = console.error;
	try {
		Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
		Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
		console.error = () => undefined;
		showPartsSplash(dom.window.document, cached);
		using errorView = showStartupError(new Error('Deliberate startup failure'), async () => undefined);
		assert.equal(dom.window.document.getElementById('ash-parts-splash'), null);
		assert.equal(dom.window.document.querySelector('.ash-initial-shell-colors'), null);
		assert.equal(dom.window.document.activeElement?.textContent, 'Retry');
		assert.equal(dom.window.document.querySelector('section')!.style.backgroundColor, 'rgb(30, 30, 30)');
		assert.equal(dom.window.document.querySelector('section')!.style.colorScheme, 'dark');
	} finally {
		console.error = originalError;
		if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
		else Reflect.deleteProperty(globalThis, 'document');
		if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
		dom.window.close();
	}
});


test('layout cache rejects unbounded geometry and retains only the normalized drawing data', () => {
	const layoutInfo = { version: 2, width: 1024, height: 768, partBounds: [{ ...drawing, privateContent: 'discard' }] };
	const normalized = validatePartsSplash({ ...cached, layoutInfo });
	assert.deepEqual(normalized.layoutInfo, { ...layoutInfo, partBounds: [drawing] });
	for (const mutation of [
		{ ...layoutInfo, version: 3 },
		{ ...layoutInfo, width: Number.POSITIVE_INFINITY },
		{ ...layoutInfo, partBounds: Array.from({ length: 17 }, () => layoutInfo.partBounds[0]) },
		{ ...layoutInfo, partBounds: [{ ...layoutInfo.partBounds[0], left: -1 }] },
		{ ...layoutInfo, partBounds: [{ ...layoutInfo.partBounds[0], width: 2000 }] },
		{ ...layoutInfo, partBounds: [{ ...layoutInfo.partBounds[0], background: 'url(secret)' }] },
		{ ...layoutInfo, partBounds: [{ ...drawing, borderRadii: [[-1, 0], ...drawing.borderRadii.slice(1)] }] },
		{ ...layoutInfo, partBounds: [{ ...drawing, borderRadii: [[0, Number.POSITIVE_INFINITY], ...drawing.borderRadii.slice(1)] }] },
		{ ...layoutInfo, partBounds: [{ ...drawing, borderRadii: drawing.borderRadii.slice(1) }] },
		{ ...layoutInfo, partBounds: [{ ...drawing, borders: drawing.borders.slice(1) }] },
		...[
			{ width: -1 }, { width: 5 }, { color: 'url(secret)' }, { style: 'solid; background: url(secret)' },
		].map(border => ({ ...layoutInfo, partBounds: [{ ...drawing, borders: [{ ...drawing.borders[0], ...border }, ...drawing.borders.slice(1)] }] })),
	]) assert.throws(() => validatePartsSplash({ ...cached, layoutInfo: mutation }), /splash/);
});

test('old splash geometry is discarded without losing the saved theme colors', () => {
	const dom = createDom();
	try {
		const previous = { ...cached, layoutInfo: { width: 1024, height: 768, partBounds: [{ left: 0, top: 0, width: 300, height: 700, background: '#abcdef', borderRadius: 6, borderWidth: 1, borderColor: '#ffffff' }] } };
		assert.deepEqual(validatePartsSplash(previous), cached);
		const ownerWindow = dom.window as unknown as Window;
		ownerWindow.localStorage.setItem(browserSplashStorageKey(ownerWindow), JSON.stringify(previous));
		showPartsSplash(dom.window.document, readBrowserPartsSplash(ownerWindow));
		assert.equal(dom.window.document.getElementById('ash-parts-splash')!.children.length, 0);
		assert.equal(dom.window.document.getElementById('ash-parts-splash')!.style.backgroundColor, 'rgb(18, 52, 86)');
	} finally { dom.window.close(); }
});

test('gradient cache retains only bounded, resolved paint data', () => {
	const backgroundGradient = { angle: 90, stops: [{ color: '#abcdef', offset: 0 }, { color: '#ffffff', offset: 280 }] };
	const layoutInfo = { version: 2, width: 1024, height: 768, partBounds: [{ ...drawing, backgroundGradient: { ...backgroundGradient, privateContent: 'discard' } }] };
	assert.deepEqual(validatePartsSplash({ ...cached, layoutInfo }).layoutInfo!.partBounds[0], { ...drawing, backgroundGradient });
	for (const gradient of [
		'linear-gradient(to right, red, blue)',
		{ ...backgroundGradient, angle: Number.NaN },
		{ ...backgroundGradient, angle: 360 },
		{ ...backgroundGradient, stops: [] },
		{ ...backgroundGradient, stops: Array.from({ length: 33 }, () => backgroundGradient.stops[0]) },
		{ ...backgroundGradient, stops: [{ color: 'url(secret)', offset: 0 }, backgroundGradient.stops[1]] },
		{ ...backgroundGradient, stops: [{ color: '#abcdef', offset: Number.POSITIVE_INFINITY }, backgroundGradient.stops[1]] },
		{ ...backgroundGradient, stops: [{ color: '#abcdef', offset: 65537 }, backgroundGradient.stops[1]] },
	]) {
		assert.throws(() => validatePartsSplash({ ...cached, layoutInfo: { ...layoutInfo, partBounds: [{ ...drawing, backgroundGradient: gradient }] } }), /splash gradient/);
	}
});

test('startup capture restores the titlebar surface split and its separator, including a collapsed sidebar', async () => {
	const dom = createDom();
	try {
		const ownerDocument = dom.window.document;
		const root = ownerDocument.getElementById('app')!;
		const part = ownerDocument.createElement('section');
		part.className = 'ash-workbench-part';
		part.style.backgroundColor = '#ffffff';
		part.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1024, bottom: 36, width: 1024, height: 36 } as DOMRect);
		root.append(part);
		using layoutChanged = new Emitter<{ width: number; height: number; }>();
		using shutdown = new Emitter<IWillShutdownEvent>();
		using themes = new TestThemeService(createColorTheme({ id: 'splash-gradient', label: 'Test', colorScheme: ColorScheme.Light }));
		using services = new InstantiationService();
		const saved: IPartsSplash[] = [];
		services.registerInstance(IThemeService, themes);
		services.registerInstance(ILayoutService, { mainContainer: root, onDidLayoutMainContainer: layoutChanged.event } as ILayoutService);
		services.registerInstance(ILifecycleService, { phase: LifecyclePhase.Restored, when: () => Promise.resolve(), onWillShutdown: shutdown.event } as unknown as ILifecycleService);
		services.registerInstance(ISplashStorageService, { saveWindowSplash: async splash => { saved.push(validatePartsSplash(JSON.parse(JSON.stringify(splash)))); } });
		for (const sidebarWidth of [280, 0]) {
			part.style.backgroundImage = `linear-gradient(to right, rgb(248, 248, 248) 0px ${sidebarWidth - 1}px, rgb(229, 229, 229) ${sidebarWidth - 1}px ${sidebarWidth}px, rgb(255, 255, 255) ${sidebarWidth}px)`;
			using capture = services.createInstance(PartsSplash);
			await Promise.resolve();
			const splash = saved.at(-1)!;
			assert.deepEqual(splash.layoutInfo!.partBounds[0].backgroundGradient, {
				angle: 90,
				stops: [
					{ color: '#f8f8f8', offset: 0 }, { color: '#f8f8f8', offset: Math.max(0, sidebarWidth - 1) },
					{ color: '#e5e5e5', offset: Math.max(0, sidebarWidth - 1) }, { color: '#e5e5e5', offset: sidebarWidth },
					{ color: '#ffffff', offset: sidebarWidth },
				],
			});
			showPartsSplash(ownerDocument, splash);
			const region = ownerDocument.querySelector<HTMLElement>('#ash-parts-splash > div')!;
			assert.equal(region.style.backgroundImage, `linear-gradient(90deg, rgb(248, 248, 248) 0px, rgb(248, 248, 248) ${Math.max(0, sidebarWidth - 1)}px, rgb(229, 229, 229) ${Math.max(0, sidebarWidth - 1)}px, rgb(229, 229, 229) ${sidebarWidth}px, rgb(255, 255, 255) ${sidebarWidth}px)`);
			assert.equal(region.style.backgroundColor, 'rgb(255, 255, 255)');
		}
	} finally { dom.window.close(); }
});

test('capture and startup drawing preserve one-sided borders and independent elliptical corners', async () => {
	const dom = createDom();
	try {
		const ownerDocument = dom.window.document;
		const root = ownerDocument.getElementById('app')!;
		const part = ownerDocument.createElement('section');
		part.className = 'ash-workbench-part';
		part.style.cssText = 'background: #abcdef; border: 0 none #abcdef; border-right: 1px dashed #ffffff; border-top-left-radius: 6px 8px; border-top-right-radius: 0; border-bottom-right-radius: 0; border-bottom-left-radius: 4% 10px;';
		part.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 700, width: 300, height: 700 } as DOMRect);
		root.append(part);
		using layoutChanged = new Emitter<{ width: number; height: number; }>();
		using shutdown = new Emitter<IWillShutdownEvent>();
		using themes = new TestThemeService(createColorTheme({ id: 'splash-geometry', label: 'Test', colorScheme: ColorScheme.Light }));
		using services = new InstantiationService();
		const saved: IPartsSplash[] = [];
		services.registerInstance(IThemeService, themes);
		services.registerInstance(ILayoutService, { mainContainer: root, onDidLayoutMainContainer: layoutChanged.event } as ILayoutService);
		services.registerInstance(ILifecycleService, { phase: LifecyclePhase.Restored, when: () => Promise.resolve(), onWillShutdown: shutdown.event } as unknown as ILifecycleService);
		services.registerInstance(ISplashStorageService, { saveWindowSplash: async splash => { saved.push(validatePartsSplash(JSON.parse(JSON.stringify(splash)))); } });
		using capture = services.createInstance(PartsSplash);
		await Promise.resolve();
		assert.equal(saved.length, 1);
		assert.deepEqual(saved[0].layoutInfo!.partBounds, [{ ...drawing, borders: drawing.borders.map((border, index) => index === 1 ? { ...border, style: 'dashed' } : border) }]);
		showPartsSplash(ownerDocument, saved[0]);
		const region = ownerDocument.querySelector<HTMLElement>('#ash-parts-splash > div')!;
		assert.equal(region.style.borderTopWidth, '0px');
		assert.equal(region.style.borderRight, '1px dashed rgb(255, 255, 255)');
		assert.equal(region.style.borderBottomWidth, '0px');
		assert.equal(region.style.borderLeftWidth, '0px');
		assert.equal(region.style.borderTopLeftRadius, '6px 8px');
		assert.equal(region.style.borderTopRightRadius, '0px 0px');
		assert.equal(region.style.borderBottomRightRadius, '0px 0px');
		assert.equal(region.style.borderBottomLeftRadius, '12px 10px');
		assert.equal(ownerDocument.getElementById('ash-parts-splash')!.getAttribute('aria-hidden'), 'true');
		assert.equal(ownerDocument.getElementById('ash-parts-splash')!.inert, true);
	} finally { dom.window.close(); }
});

test('browser startup fallback resolves all four OS color schemes from registered tokens', () => {
	const dom = createDom();
	try {
		for (const [dark, contrast, baseTheme, background] of [
			[false, false, ColorScheme.Light, '#ffffff'], [true, false, ColorScheme.Dark, '#1e1e1e'],
			[false, true, ColorScheme.HighContrastLight, '#ffffff'], [true, true, ColorScheme.HighContrastDark, '#000000'],
		] as const) {
			Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: query.includes('dark') ? dark : contrast }) });
			const splash = readBrowserPartsSplash(dom.window as unknown as Window);
			assert.deepEqual([splash.baseTheme, splash.colorInfo.background], [baseTheme, background]);
		}
	} finally { dom.window.close(); }
});
