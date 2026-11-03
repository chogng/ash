import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { constObservable } from '../../../../../base/common/observable.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { createColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ILifecycleService, LifecyclePhase, type IWillShutdownEvent } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { browserSplashStorageKey, readBrowserPartsSplash } from '../../../../../workbench/contrib/splash/browser/splash.js';
import '../../../../../workbench/common/theme.js';
import '../../../../../workbench/contrib/splash/browser/browserSplashStorageService.js';
import '../../browser/splash.contribution.js';
import { showSessionsSplash, showSessionsSplashForRestore } from '../../browser/sessionsSplash.js';

test('Agent Window places its skeleton in cached visible Parts and removes it after page restoration', async () => {
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
		const composer = ownerDocument.createElement('div');
		composer.className = 'ash-chatgpt-composer';
		composer.style.visibility = 'visible';
		composer.getBoundingClientRect = () => ({ left: 450, top: 670, right: 950, bottom: 750, width: 500, height: 80 } as DOMRect);
		main.append(composer);
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
		services.registerInstance(ILifecycleService, { phase: LifecyclePhase.Restored, when: () => Promise.resolve(), onWillShutdown: shutdown.event } as unknown as ILifecycleService);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.contrib.splash']);
		host.advance(WorkbenchPhase.BlockStartup);
		layout.fire({ width: 0, height: 0 });
		assert.equal(ownerDocument.querySelectorAll('.ash-sessions-splash-fallback .ash-sessions-splash-sidebar > div').length, 3);
		assert.equal(ownerDocument.querySelector('.ash-sessions-splash-chat'), null);
		showSessionsSplashForRestore(ownerDocument, 'sessions.open.new');
		assert.equal(ownerDocument.querySelectorAll('.ash-sessions-splash-fallback .ash-sessions-splash-chat > div').length, 2);
		layout.fire({ width: 1024, height: 768 });
		assert.ok(ownerDocument.getElementById('ash-parts-splash'));
		await Promise.resolve();
		assert.equal(ownerDocument.getElementById('ash-parts-splash'), null);
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
		// An older cache can still supply the shell geometry, but never guesses the page.
		const { skeleton: _skeleton, ...legacyEditor } = resized.layoutInfo!.partBounds[1];
		const legacy = { ...resized, layoutInfo: { ...resized.layoutInfo!, partBounds: [resized.layoutInfo!.partBounds[0], { ...legacyEditor, id: 'editor' }] } };
		showSessionsSplash(ownerDocument, legacy);
		assert.equal(ownerDocument.querySelector('.ash-sessions-splash-chat'), null);
		showSessionsSplashForRestore(ownerDocument, 'sessions.show.projects');
		assert.equal(ownerDocument.querySelectorAll('[data-part=editor] .ash-sessions-splash-cards > div').length, 8);
		showSessionsSplash(ownerDocument, legacy);
		showSessionsSplashForRestore(ownerDocument, 'sessions.open.customize');
		assert.equal(ownerDocument.querySelector('.ash-sessions-splash-chat, .ash-sessions-splash-cards'), null);
		showSessionsSplash(ownerDocument, resized);
		const shell = ownerDocument.getElementById('ash-parts-splash')!;
		assert.equal(shell.getAttribute('aria-hidden'), 'true');
		assert.equal(shell.inert, true);
		assert.equal((shell.firstElementChild as HTMLElement).style.width, '412px');
		assert.equal((shell.lastElementChild as HTMLElement).style.height, '236px');
		assert.equal(shell.querySelectorAll('[data-part=sidebar] .ash-sessions-splash-sidebar > div').length, 3);
		assert.equal(shell.querySelectorAll('[data-part=sessions] .ash-sessions-splash-shape.surface').length, 1);
		assert.equal(shell.querySelector('.ash-sessions-splash-cards'), null);
		assert.equal(shell.querySelector('.ash-sessions-splash-fallback'), null);
		sidebar.hidden = true;
		layout.fire({ width: 1024, height: 768 });
		await saveBeforeShutdown();
		const hiddenSidebar = readBrowserPartsSplash(ownerWindow);
		assert.deepEqual(hiddenSidebar.layoutInfo?.partBounds.map(part => part.id), ['sessions']);
		assert.deepEqual(hiddenSidebar.layoutInfo?.partBounds[0]?.skeleton, resized.layoutInfo!.partBounds[1].skeleton);
		showSessionsSplash(ownerDocument, hiddenSidebar);
		assert.equal(ownerDocument.querySelector('.ash-sessions-splash-sidebar'), null);

		// A page switch inside the same part can change the splash without resizing the window.
		main.dataset.part = 'editor';
		const projects = ownerDocument.createElement('section');
		projects.toggleAttribute('data-splash-grid', true);
		projects.getBoundingClientRect = main.getBoundingClientRect;
		main.replaceChildren(projects);
		await new Promise(resolve => setTimeout(resolve, 150));
		showSessionsSplash(ownerDocument, readBrowserPartsSplash(ownerWindow));
		assert.equal(ownerDocument.querySelectorAll('[data-part=editor] .ash-sessions-splash-cards > div').length, 8);
		// Restorable custom views capture their own content instead of the outgoing editor.
		main.dataset.part = 'customview';
		const view = ownerDocument.createElement('section');
		main.replaceChildren(view);
		const heading = ownerDocument.createElement('h1');
		heading.style.visibility = 'visible';
		heading.textContent = 'Private project name';
		heading.getBoundingClientRect = () => ({ left: 430, top: 560, right: 700, bottom: 600, width: 270, height: 40 } as DOMRect);
		view.append(heading);
		await saveBeforeShutdown();
		const customView = readBrowserPartsSplash(ownerWindow);
		assert.equal(JSON.stringify(customView).includes(heading.textContent), false);
		showSessionsSplash(ownerDocument, customView);
		assert.equal(ownerDocument.querySelectorAll('[data-part=customview] .ash-sessions-splash-shape').length, 1);
		assert.equal(ownerDocument.querySelector('.ash-sessions-splash-cards'), null);
		assert.equal(ownerWindow.localStorage.getItem(editorKey), 'editor-owned-cache');
		assert.deepEqual(Object.keys(ownerWindow.localStorage).sort(), [editorKey, browserSplashStorageKey(ownerWindow)].sort());
	} finally {
		dom.window.close();
	}
});

test('Agent Window uses the sidebar bounds and border from a cache without Part IDs', () => {
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
		showSessionsSplash(document, {
			baseTheme: ColorScheme.Light,
			colorInfo: { background: '#ffffff', foreground: '#000000' },
			layoutInfo: {
				version: 2, width: innerWidth, height: innerHeight,
				partBounds: [
					{ ...paint, left: 0, top: 0, width: innerWidth, height: 35 },
					{ ...paint, left: 0, top: 35, width: 225, height: innerHeight - 35, borders: [emptyBorder, sidebarBorder, emptyBorder, emptyBorder] },
					{ ...paint, left: 225, top: 35, width: innerWidth - 225, height: innerHeight - 35 },
				],
			},
		});
		const shell = document.querySelector('#ash-parts-splash')!;
		assert.equal(shell.querySelector('.ash-sessions-splash-fallback'), null);
		assert.equal(shell.querySelectorAll('[data-part="sidebar"] .ash-sessions-splash-sidebar > div').length, 3);
		const separator = shell.querySelector<HTMLElement>('[data-part="titlebar"] .ash-sessions-splash-titlebar-separator')!;
		assert.equal(separator.style.left, '224px');
		assert.equal(separator.style.borderRightWidth, '1px');
		showSessionsSplashForRestore(document, 'sessions.open.new');
		assert.ok(shell.querySelector('[data-part="legacy-main"] .ash-sessions-splash-chat'));
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
