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
	const layoutInfo = { width: 1024, height: 768, partBounds: [{ left: 0, top: 0, width: 300, height: 700, background: '#abcdef', borderRadius: 6, borderColor: '#ffffff', borderWidth: 1, privateContent: 'discard' }] };
	const normalized = validatePartsSplash({ ...cached, layoutInfo });
	assert.deepEqual(normalized.layoutInfo, { width: 1024, height: 768, partBounds: [{ left: 0, top: 0, width: 300, height: 700, background: '#abcdef', borderRadius: 6, borderColor: '#ffffff', borderWidth: 1 }] });
	for (const mutation of [
		{ ...layoutInfo, width: Number.POSITIVE_INFINITY },
		{ ...layoutInfo, partBounds: Array.from({ length: 17 }, () => layoutInfo.partBounds[0]) },
		{ ...layoutInfo, partBounds: [{ ...layoutInfo.partBounds[0], left: -1 }] },
		{ ...layoutInfo, partBounds: [{ ...layoutInfo.partBounds[0], width: 2000 }] },
		{ ...layoutInfo, partBounds: [{ ...layoutInfo.partBounds[0], background: 'url(secret)' }] },
	]) assert.throws(() => validatePartsSplash({ ...cached, layoutInfo: mutation }), /splash/);
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
