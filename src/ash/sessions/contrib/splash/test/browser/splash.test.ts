import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { createColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService, validatePartsSplash } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ILifecycleService, LifecyclePhase, type IWillShutdownEvent } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { browserSplashStorageKey, readBrowserPartsSplash } from '../../../../../workbench/contrib/splash/browser/splash.js';
import '../../../../../workbench/common/theme.js';
import '../../../../../workbench/contrib/splash/browser/browserSplashStorageService.js';
import '../../browser/splash.contribution.js';
import { showSessionsSplash } from '../../browser/sessionsSplash.js';

test('Agent Window hands off at the first live layout and caches only shell paint after restoration', async () => {
	const dom = new JSDOM('<main></main>', { url: 'https://ash.test/browser/sessions/sessions.html' });
	try {
		const ownerWindow = dom.window as unknown as Window;
		const ownerDocument = dom.window.document;
		Object.defineProperty(ownerWindow.performance, 'mark', { value: () => undefined });
		const root = ownerDocument.querySelector('main')!;
		let sidebarWidth = 300;
		let mainHeight = 168;
		const sidebar = ownerDocument.createElement('section');
		sidebar.className = 'ash-workbench-part';
		sidebar.dataset.part = 'sidebar';
		sidebar.style.cssText = 'background: #abcdef; border-right: 1px solid #ffffff';
		sidebar.getBoundingClientRect = () => ({ left: 0, top: 0, right: sidebarWidth, bottom: 768, width: sidebarWidth, height: 768 } as DOMRect);
		const main = ownerDocument.createElement('section');
		main.className = 'ash-workbench-part';
		main.dataset.part = 'sessions';
		main.getBoundingClientRect = () => ({ left: sidebarWidth, top: 768 - mainHeight, right: 1024, bottom: 768, width: 1024 - sidebarWidth, height: mainHeight } as DOMRect);
		const content = ownerDocument.createElement('p');
		content.style.visibility = 'visible';
		content.getBoundingClientRect = () => assert.fail('Splash cache measured conversation content');
		main.append(content);
		root.append(sidebar, main);
		const editorKey = 'ash.partsSplash:/browser/workbench/workbench.html:[null,null,null]';
		ownerWindow.localStorage.setItem(editorKey, 'editor-owned-cache');
		showSessionsSplash(ownerDocument, { baseTheme: ColorScheme.Dark, colorInfo: { background: '#123456', foreground: '#ffffff' } });
		using layout = new Emitter<{ width: number; height: number; }>();
		using shutdown = new Emitter<IWillShutdownEvent>();
		using themes = new TestThemeService(createColorTheme({ id: 'test', label: 'Test', colorScheme: ColorScheme.Light }));
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors().filter(([id]) => id !== ICustomViewService)));
		services.registerInstance(ICustomViewService, { activeCustomViewOpen: constObservable(undefined) } as ICustomViewService);
		services.registerInstance(ILayoutService, { mainContainer: root, onDidLayoutMainContainer: layout.event } as ILayoutService);
		services.registerInstance(IThemeService, themes);
		const restored = new DeferredPromise<void>();
		let phase = LifecyclePhase.Ready;
		services.registerInstance(ILifecycleService, { get phase() { return phase; }, when: () => restored.p, onWillShutdown: shutdown.event } as unknown as ILifecycleService);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.contrib.splash']);
		host.advance(WorkbenchPhase.BlockStartup);
		layout.fire({ width: 0, height: 0 });
		assert.equal(ownerDocument.getElementById('ash-parts-splash')!.children.length, 0);
		layout.fire({ width: 1024, height: 768 });
		assert.equal(ownerDocument.getElementById('ash-parts-splash'), null);
		assert.equal(ownerWindow.localStorage.getItem(browserSplashStorageKey(ownerWindow)), null);
		phase = LifecyclePhase.Restored;
		await restored.complete(undefined);
		assert.deepEqual(readBrowserPartsSplash(ownerWindow).layoutInfo?.partBounds.map(part => [part.width, part.height]), [[300, 768], [724, 168]]);
		const saveBeforeShutdown = async (): Promise<void> => {
			const writes: Promise<unknown>[] = [];
			shutdown.fire({ reason: 'quit', join: operation => { if (typeof operation !== 'function') writes.push(operation); } });
			await Promise.all(writes);
		};
		sidebarWidth = 412;
		mainHeight = 236;
		layout.fire({ width: 1024, height: 768 });
		await saveBeforeShutdown();
		const resized = readBrowserPartsSplash(ownerWindow);
		assert.deepEqual(resized.layoutInfo?.partBounds.map(part => [part.left, part.top, part.width, part.height]), [[0, 0, 412, 768], [412, 532, 612, 236]]);
		showSessionsSplash(ownerDocument, resized);
		const shell = ownerDocument.getElementById('ash-parts-splash')!;
		assert.equal(shell.getAttribute('aria-hidden'), 'true');
		assert.equal(shell.inert, true);
		assert.equal((shell.firstElementChild as HTMLElement).style.width, '412px');
		assert.equal((shell.lastElementChild as HTMLElement).style.height, '236px');
		assert.equal(shell.querySelectorAll(':scope > div > *').length, 0);
		sidebar.hidden = true;
		layout.fire({ width: 1024, height: 768 });
		await saveBeforeShutdown();
		const hiddenSidebar = readBrowserPartsSplash(ownerWindow);
		assert.deepEqual(hiddenSidebar.layoutInfo?.partBounds.map(part => part.id), ['sessions']);
		showSessionsSplash(ownerDocument, hiddenSidebar);
		assert.equal(ownerDocument.querySelector('#ash-parts-splash [data-part="sidebar"]'), null);
		assert.equal(ownerWindow.localStorage.getItem(editorKey), 'editor-owned-cache');
		assert.deepEqual(Object.keys(ownerWindow.localStorage).sort(), [editorKey, browserSplashStorageKey(ownerWindow)].sort());
	} finally {
		dom.window.close();
	}
});

test('Agent Window keeps older shell paint and drops cached content geometry', () => {
	const dom = new JSDOM();
	try {
		const { document, innerWidth, innerHeight, performance } = dom.window;
		Object.defineProperty(performance, 'mark', { value: () => undefined });
		const emptyBorder = { width: 0, style: 'none', color: '#ffffff' };
		const sidebarBorder = { width: 1, style: 'solid', color: '#dddddd' };
		const paint = {
			background: '#ffffff',
			borders: Array.from({ length: 4 }, () => emptyBorder),
			borderRadii: Array.from({ length: 4 }, () => [0, 0] as const),
		};
		const legacy = {
			baseTheme: ColorScheme.Light,
			colorInfo: { background: '#ffffff', foreground: '#000000' },
			layoutInfo: {
				version: 2, width: innerWidth, height: innerHeight,
				partBounds: [
					{ ...paint, left: 0, top: 0, width: innerWidth, height: 35 },
					{ ...paint, left: 0, top: 35, width: 225, height: innerHeight - 35, borders: [emptyBorder, sidebarBorder, emptyBorder, emptyBorder] },
					{
						...paint, left: 225, top: 35, width: innerWidth - 225, height: innerHeight - 35,
						skeleton: { shapes: [{ left: 0.1, top: 0.2, width: 0.8, height: 0.1 }] },
					},
				],
			},
		};
		const splash = validatePartsSplash(legacy);
		assert.equal('skeleton' in splash.layoutInfo!.partBounds[2], false);
		showSessionsSplash(document, splash);
		const shell = document.querySelector('#ash-parts-splash')!;
		assert.equal(shell.children.length, 3);
		assert.equal(shell.querySelector('[data-part="sidebar"]')!.children.length, 0);
		assert.equal(shell.lastElementChild!.children.length, 0);
		const separator = shell.querySelector<HTMLElement>('[data-part="titlebar"] .ash-sessions-splash-titlebar-separator')!;
		assert.equal(separator.style.left, '224px');
		assert.equal(separator.style.borderRightWidth, '1px');

		showSessionsSplash(document, { ...splash, layoutInfo: { ...splash.layoutInfo!, width: innerWidth + 100 } });
		assert.equal(document.querySelector('#ash-parts-splash')!.children.length, 0);
	} finally {
		dom.window.close();
	}
});

test('Agent Window splash requires the shared runtime storage registration', () => {
	using themes = new TestThemeService(createColorTheme({ id: 'test', label: 'Test', colorScheme: ColorScheme.Light }));
	using services = new InstantiationService();
	services.registerInstance(IThemeService, themes);
	services.registerInstance(ICustomViewService, { activeCustomViewOpen: constObservable(undefined) } as ICustomViewService);
	services.registerInstance(ILayoutService, {} as ILayoutService);
	services.registerInstance(ILifecycleService, { onWillShutdown: Event.None } as ILifecycleService);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.contrib.splash']);
	assert.throws(() => host.advance(WorkbenchPhase.BlockStartup), /ISplashStorageService/);
});
