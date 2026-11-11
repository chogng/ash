/// <reference types="@webgpu/types" />
/// <reference path="../../../../src/typings/editContext.d.ts" />

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import type * as Stanza from '../../../../src/ash/editor/editor.main.js';
import { createLogger, createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import type { DisposableStore } from '../../../../src/ash/base/common/lifecycle.js';
import type { ChatInputTipPresenter } from '../../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import type { ChatWidget } from '../../../../src/ash/workbench/contrib/chat/browser/widget/chatWidget.js';
import type { NativeChatWidget } from '../../../../src/ash/sessions/contrib/chat/browser/widget/nativeChatWidget.js';
import type { ViewPane } from '../../../../src/ash/workbench/browser/parts/views/viewPane.js';
import type { IModelPickerDelegate } from '../../../../src/ash/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import type { Emitter } from '../../../../src/ash/base/common/event.js';
import type { IUntitledChatSession } from '../../../../src/ash/sessions/services/sessions/common/session.js';

declare global {
	var uiHotReloadEvidence: {
		readonly scope: DisposableStore;
		readonly document: Document;
		readonly editor: ReturnType<typeof Stanza.editor.getEditors>[number];
		readonly model: ReturnType<typeof Stanza.editor.getModels>[number];
		readonly chat: ChatWidget | NativeChatWidget;
		readonly chatListClass: string;
		readonly sidebar: ViewPane;
		readonly changes: Emitter<void>;
		readonly opened: string[];
		previous: HTMLElement;
		previousButton: HTMLButtonElement | undefined;
	};
	var widgetHotReloadEvidence: {
		readonly scope: DisposableStore;
		readonly presenter: ChatInputTipPresenter;
		readonly editor: ReturnType<typeof Stanza.editor.getEditors>[number];
		readonly model: ReturnType<typeof Stanza.editor.getModels>[number];
		readonly root: HTMLElement | null;
		readonly host: HTMLElement;
		readonly document: Document;
		previous: HTMLElement;
		previousButton: HTMLButtonElement;
	};
	var stanza: typeof Stanza;
	var hotReloadUpdateCount: number;
	var hotReloadEvidence: {
		readonly editor: ReturnType<typeof Stanza.editor.getEditors>[number];
		readonly model: ReturnType<typeof Stanza.editor.getModels>[number];
		readonly root: HTMLElement | null;
		readonly document: Document;
		previous: Element | null;
	};
}

for (const chatSurface of ['code', 'chat'] as const) {
	test(`development rebuilds model cards, chat transcripts, and the Sessions sidebar while retaining their state (${chatSurface})`, { tag: ['@browser-ui', '@electron-ui'] }, async ({ playwright }, testInfo) => {

		test.setTimeout(180_000);
		const desktopDirectory = resolve(import.meta.dirname, '../../../..');
		const paths = {
			card: 'workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerCard.ts',
			chat: 'workbench/contrib/chat/browser/widget/chatListWidget.ts',
			sidebar: 'sessions/contrib/sessions/browser/views/sessionsList.ts',
		};
		const sources = await Promise.all(Object.entries(paths).map(async ([name, path]) => {
			const file = resolve(desktopDirectory, 'src/ash', path);
			const original = await readFile(file, 'utf8');
			return { name, file, original, written: original };
		}));
		const profile = await mkdtemp(join(tmpdir(), 'ash-ui-widgets-hmr-'));
		const server = await createServer({ configFile: resolve(desktopDirectory, 'build/desktop/vite/editor.vite.config.ts'), server: { port: 5195, strictPort: true } });
		let electron: ElectronApplication | undefined;
		let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
		try {
			await server.listen();
			let page: Page;
			if (testInfo.project.name === 'electron-ui') {
				const configuration = resolveElectronConfiguration({ desktopDirectory, appServerMode: 'disabled', userDataDirectory: profile });
				electron = await _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, env: configuration.env, executablePath: configuration.executablePath });
				page = await electron.firstWindow();
				await page.waitForLoadState('load');
			} else {
				browser = await playwright.chromium.launch();
				page = await browser.newPage();
			}
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('http://127.0.0.1:5195/');
			await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(1);
			await page.evaluate(async ({ root, chatSurface }) => {
				const clientUrl = '/@vite/client';
				const client = await import(clientUrl);
				globalThis.hotReloadUpdateCount = 0;
				client.createHotContext('/ash-ui-widgets-hmr').on('vite:afterUpdate', () => globalThis.hotReloadUpdateCount++);
				const moduleUrl = (path: string): string => `/@fs/${root.replaceAll('\\', '/').replace(/^\//u, '')}/src/ash/${path}`;
				const { DisposableStore, toDisposable } = await import(moduleUrl('base/common/lifecycle.ts'));
				const { Emitter, Event } = await import(moduleUrl('base/common/event.ts'));
				const { constObservable } = await import(moduleUrl('base/common/observable.ts'));
				const { createTestEditorServices } = await import(moduleUrl('workbench/test/common/testEditorServices.ts'));
				const { registerCodeEditorServices } = await import(moduleUrl('editor/test/browser/testCodeEditor.ts'));
				const { IAccessibleViewService } = await import(moduleUrl('platform/accessibility/browser/accessibleView.ts'));
				const { IAgentVoiceService } = await import(moduleUrl('platform/agentHost/common/agentService.ts'));
				const { IVoiceModeOnboardingService, VoiceModeOnboardingService } = await import(moduleUrl('workbench/contrib/agentsVoice/browser/voiceModeOnboarding.ts'));
				const { IDialogService } = await import(moduleUrl('platform/dialogs/common/dialogs.ts'));
				const { DialogService } = await import(moduleUrl('workbench/services/dialogs/common/dialogService.ts'));
				const { ModelPickerWidget } = await import(moduleUrl('workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerWidget.ts'));
				const { ILanguageModelsService } = await import(moduleUrl('workbench/contrib/chat/common/languageModels.ts'));
				const chatModule = await import(moduleUrl(chatSurface === 'code' ? 'workbench/contrib/chat/browser/widget/chatWidget.ts' : 'sessions/contrib/chat/browser/widget/nativeChatWidget.ts'));
				const ChatWidget = chatSurface === 'code' ? chatModule.ChatWidget : chatModule.NativeChatWidget;
				const { SessionsViewRegistry } = await import(moduleUrl('sessions/common/views.ts'));
				const { registerSessionsNavigation, SESSIONS_NAVIGATION_CONTAINER_ID } = await import(moduleUrl('sessions/contrib/sessions/browser/views/sessionsView.ts')) as typeof import('../../../../src/ash/sessions/contrib/sessions/browser/views/sessionsView.js');
				const { ISessionsManagementService } = await import(moduleUrl('sessions/services/sessions/common/sessionsManagement.ts'));
				const { ISessionsService } = await import(moduleUrl('sessions/services/sessions/browser/sessionsService.ts'));
				const { IGitHubService } = await import(moduleUrl('sessions/contrib/github/browser/githubService.ts'));
				const { ISessionGroupsService } = await import(moduleUrl('sessions/services/sessions/browser/sessionGroupsService.ts'));
				const { ISessionsListModelService, SessionsListModelService } = await import(moduleUrl('sessions/services/sessions/browser/sessionsListModelService.ts'));
				const { ISessionSectionOrderService, SessionSectionOrderService } = await import(moduleUrl('sessions/services/sessions/browser/sessionSectionOrderService.ts'));
				const { IBlockedSessionsIndicatorService } = await import(moduleUrl('sessions/contrib/sessions/browser/blockedSessionsIndicatorModel.ts'));
				const { IProjectService } = await import(moduleUrl('platform/projects/common/projectService.ts'));
				const { IProjectDialogService } = await import(moduleUrl('sessions/contrib/projects/browser/projectDialogService.ts'));
				const { IProjectsService, ProjectsService } = await import(moduleUrl('sessions/contrib/projects/browser/projectsService.ts'));
				const { ISessionProviderScopeService } = await import(moduleUrl('sessions/browser/agentHost/sessionProviderScopeService.ts'));
				const { IAgentSessionActionsService } = await import(moduleUrl('workbench/contrib/chat/browser/agentSessions/agentSessionsService.ts'));
				const { IStorageService } = await import(moduleUrl('platform/storage/common/storage.ts'));
				const { writeNewChatDraftState } = await import(moduleUrl('sessions/contrib/chat/common/newChatDraftState.ts'));
				const chatInputStatePersistence = await import(moduleUrl('workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.ts'));
				const scope = new DisposableStore();
				const services = scope.add(createTestEditorServices());
				services.registerInstance(IAgentVoiceService, undefined);
				services.registerInstance(IDialogService, scope.add(new DialogService()));
				registerCodeEditorServices(services);
				services.registerInstance(IVoiceModeOnboardingService, scope.add(services.createInstance(VoiceModeOnboardingService)));
				services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined, show: () => undefined });
				const host = document.createElement('main');
				host.id = 'ui-hot-reload-host';
				const style = document.createElement('style');
				style.textContent = '#ui-hot-reload-host { position: fixed; inset: 0; background: white; overflow: auto; z-index: 100; } #ui-hot-reload-host .ash-chat, #ui-hot-reload-host .ash-native-chat { width: 700px; height: 350px; } #ui-hot-reload-host .ash-chat-list-widget, #ui-hot-reload-host .ash-native-chat-list-widget { height: 160px; flex: none; } #ui-hot-reload-host .ash-sessions-list { height: 300px; width: 300px; box-sizing: border-box; }';
				host.append(style);
				document.body.append(host);
				scope.add(toDisposable(() => host.remove()));
				const opened: string[] = [];
				const models = [{ model: { provider: 'test', model: 'first' }, displayName: 'Test Model', description: 'Retained description', longContext: false }, { model: { provider: 'test', model: 'second' }, displayName: 'Second Model', description: 'Second description', longContext: false }];
				const delegate: IModelPickerDelegate = {
					onDidChangePresentation: Event.None,
					getModels: () => models, getSelectedModel: () => models[0]!.model, getSelectedModelEntry: () => models[0], getSelectedReasoningEffort: () => undefined,
					isAutomaticModel: () => false, getModelsError: () => undefined,
					selectModel: async () => { opened.push('model'); }, selectAutomaticModel: async () => undefined,
					selectReasoningEffort: async () => undefined, openSettings: async () => undefined,
				};
				services.registerInstance(ILanguageModelsService, { onDidChangeModels: Event.None, listModelProviders: async () => [] });
				const picker = scope.add(services.createInstance(ModelPickerWidget, delegate));
				picker.render(host);
				const editor = globalThis.stanza.editor.getEditors()[0]!;
				const model = editor.getModel()!;
				model.setValue('retained composer draft');
				const changes = scope.add(new Emitter());
				const items = [
					{ id: 'advisor', type: 'advisor', text: 'Keep this folded', transient: false },
					...Array.from({ length: 35 }, (_, index) => ({ id: `message-${index}`, type: 'userMessage', text: `Message ${index}`, transient: false })),
					{ id: 'error', type: 'turnError', text: 'Retained failure', transient: false, action: { type: 'startNewChat', label: 'Start a new chat' } },
				];
				const conversation = Object.assign(toDisposable(() => undefined), { onDidChange: changes.event, onDidChangeComposer: Event.None, composerGeneration: 0, items, inputState: {} });
				// Retain the real Stanza editor through ChatWidget's input factory boundary.
				const createInput = (container: HTMLElement) => {
					const element = document.createElement('div');
					container.append(element);
					element.append(editor.getDomNode()!);
					return Object.assign(toDisposable(() => element.remove()), { element, render: () => undefined, setVisible: () => undefined, focus: () => editor.focus() });
				};
				const chat = scope.add(chatSurface === 'code'
					? services.createInstance(ChatWidget, host, 'hot-reload-chat', conversation, () => opened.push('chat'), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, createInput, undefined)
					: services.createInstance(ChatWidget, host, 'hot-reload-chat', conversation, () => opened.push('chat'), createInput));
				chat.setVisible(true);
				const storage = services.get(IStorageService);
				const drafts = Array.from({ length: 40 }, (_, index): IUntitledChatSession => ({
					untitledSessionId: `draft-${index}`, kind: 'code', title: `Draft ${index}`, model: undefined, agent: undefined, workspace: { type: 'current' },
				}));
				for (const draft of drafts) {
					writeNewChatDraftState(storage, { mode: 'agent', text: draft.title, contexts: [] }, `untitled:${draft.untitledSessionId}`, chatInputStatePersistence);
				}
				const selection = { kind: 'untitled', session: drafts[3]! };
				services.registerInstance(ISessionsManagementService, { onDidChange: changes.event, sessions: [], untitledSessions: drafts, state: 'ready' });
				services.registerInstance(ISessionsService, { onDidChange: changes.event, visibleSelections: [selection], activeSelection: selection, openUntitledSession: async (id: string) => { opened.push(id); } });
				services.registerInstance(IGitHubService, { onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [] });
				services.registerInstance(ISessionGroupsService, { onDidChange: Event.None, groups: [] });
				services.registerInstance(ISessionsListModelService, services.createInstance(SessionsListModelService));
				services.registerInstance(ISessionSectionOrderService, services.createInstance(SessionSectionOrderService));
				services.registerInstance(IBlockedSessionsIndicatorService, { blockedSessions: constObservable([]) });
				services.registerInstance(IProjectService, { onDidChange: Event.None, list: async () => [] });
				services.registerInstance(IProjectDialogService, { close: () => undefined });
				services.registerInstance(IProjectsService, scope.add(services.createInstance(ProjectsService)));
				services.registerInstance(ISessionProviderScopeService, undefined);
				services.registerInstance(IAgentSessionActionsService, undefined);
				scope.add(registerSessionsNavigation());
				const descriptor = SessionsViewRegistry.getViews(SESSIONS_NAVIGATION_CONTAINER_ID)[0]!.ctorDescriptor!;
				const sidebar = scope.add(services.createInstance(descriptor, host, { id: 'hmr-sidebar', title: 'Sessions' }));
				sidebar.setVisible(true);
				globalThis.uiHotReloadEvidence = { scope, document, editor, model, chat, chatListClass: chatSurface === 'code' ? 'ash-chat-list-widget' : 'ash-native-chat-list-widget', sidebar, changes, opened, previous: host, previousButton: undefined };
			}, { root: desktopDirectory, chatSurface });
			const host = page.locator('#ui-hot-reload-host');
			const patch = async (name: string, marker: string, statement: string, version: string): Promise<void> => {
				const source = sources.find(source => source.name === name)!;
				source.written = source.original.replace(marker, `${marker}\n\t\t${statement} = '${version}';`);
				expect(source.written).not.toBe(source.original);
				const temporary = `${source.file}.ash-hot-reload`;
				await writeFile(temporary, source.written);
				await rename(temporary, source.file);
			};
			await host.locator('.ash-chat-input-model-action').press('Enter');
			const menu = page.locator('.ash-chat-model-picker');
			const filter = menu.locator('input[type="search"]');
			await filter.fill('Test');
			await filter.press('ArrowDown');
			await filter.press('ArrowRight');
			for (const version of ['first', 'second']) {
				await expect(menu.locator('.ash-chat-model-card')).toBeFocused();
				await page.evaluate(() => { globalThis.uiHotReloadEvidence.previous = document.querySelector('.ash-chat-model-card')!; });
				await patch('card', 'this.domNode.tabIndex = -1;', 'this.domNode.dataset.hotReloadVersion', version);
				await expect(menu.locator('.ash-chat-model-card')).toHaveAttribute('data-hot-reload-version', version);
				await expect(menu.locator('.ash-chat-model-card')).toHaveCount(1);
				await expect(menu.locator('.ash-chat-model-card-description')).toHaveText('Retained description');
				await expect(menu.locator('.ash-chat-model-card')).toBeFocused();
				await expect(filter).toHaveValue('Test');
				expect(await page.evaluate(() => !globalThis.uiHotReloadEvidence.previous.isConnected)).toBe(true);
			}
			await page.keyboard.press('Escape');
			await expect(menu).toHaveCount(0);
			await host.locator('[data-item-id="advisor"] summary').click();
			await expect(host.locator('[data-item-id="advisor"] details')).not.toHaveAttribute('open');
			const transcript = host.locator(chatSurface === 'code' ? '.ash-chat-list-widget' : '.ash-native-chat-list-widget');
			const transcriptViewport = transcript.locator(':scope > .ash-scrollbar-viewport');
			// Use the scrollbar's keyboard path so its reading/following state sees the scroll.
			await transcript.press('Home');
			for (let line = 0; line < 3; line++) await transcript.press('ArrowDown');
			await expect.poll(() => transcriptViewport.evaluate(element => element.scrollTop)).toBe(120);
			await page.evaluate(() => {
				const evidence = globalThis.uiHotReloadEvidence;
				evidence.editor.focus();
				evidence.editor.setSelection({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 7 });
			});
			for (const version of ['first', 'second']) {
				await page.evaluate(focus => {
					const evidence = globalThis.uiHotReloadEvidence;
					evidence.previous = evidence.chat.element.querySelector(`.${evidence.chatListClass}`)!;
					evidence.previousButton = evidence.previous.querySelector('[data-item-id="error"] button')!;
					if (focus) evidence.previousButton.focus({ preventScroll: true });
				}, version === 'second');
				const top = await transcriptViewport.evaluate(element => element.scrollTop);
				await patch('chat', "this.transcript.setAttribute('aria-live', 'polite');", 'this.domNode.dataset.hotReloadVersion', version);
				await expect(transcript).toHaveAttribute('data-hot-reload-version', version);
				await expect(host.locator('[data-item-id]')).toHaveCount(37);
				await expect(host.locator('[data-item-id="advisor"] details')).not.toHaveAttribute('open');
				await expect.poll(() => transcriptViewport.evaluate(element => element.scrollTop)).toBeCloseTo(top, 0);
				await page.evaluate(() => { globalThis.uiHotReloadEvidence.previousButton!.click(); });
				expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.opened)).toEqual([]);
				expect(await page.evaluate(() => !globalThis.uiHotReloadEvidence.previous.isConnected)).toBe(true);
				if (version === 'first') expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.editor.hasTextFocus())).toBe(true);
				else await expect(host.getByRole('button', { name: 'Start a new chat', exact: true })).toBeFocused();
			}
			await host.getByRole('button', { name: 'Start a new chat', exact: true }).press('Enter');
			expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.opened)).toEqual(['chat']);
			const readingTop = await transcriptViewport.evaluate(element => element.scrollTop);
			await page.evaluate(() => { globalThis.uiHotReloadEvidence.chat.setVisible(false); });
			await patch('chat', "this.transcript.setAttribute('aria-live', 'polite');", 'this.domNode.dataset.hotReloadVersion', 'hidden');
			await expect(transcript).toHaveAttribute('data-hot-reload-version', 'hidden');
			await expect(transcript).toBeHidden();
			await page.evaluate(() => { globalThis.uiHotReloadEvidence.chat.setVisible(true); });
			await expect.poll(() => transcriptViewport.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0);
			const search = host.locator('.ash-sessions-list input[type="search"]');
			const sidebarViewport = host.locator('.ash-sessions-list-items > .ash-scrollbar-viewport');
			const selectedDraft = host.getByRole('button', { name: 'Draft 3 (draft)', exact: true });
			await host.locator('.ash-sessions-list').press('ControlOrMeta+f');
			await search.fill('Draft');
			await sidebarViewport.evaluate(element => { element.scrollTop = 70; });
			await expect.poll(() => sidebarViewport.evaluate(element => element.scrollTop)).toBe(70);
			for (const version of ['first', 'second']) {
				if (version === 'second') await selectedDraft.focus();
				await page.evaluate(() => {
					const evidence = globalThis.uiHotReloadEvidence;
					evidence.previous = evidence.sidebar.element.querySelector('.ash-sessions-list')!;
					evidence.previousButton = evidence.previous.querySelector<HTMLButtonElement>('.ash-sessions-list-item')!;
				});
				const top = await sidebarViewport.evaluate(element => element.scrollTop);
				await patch('sidebar', "this.domNode.className = 'ash-sessions-list';", 'this.domNode.dataset.hotReloadVersion', version);
				await expect(host.locator('.ash-sessions-list')).toHaveAttribute('data-hot-reload-version', version);
				await expect(host.locator('.ash-sessions-list')).toHaveCount(1);
				await expect(search).toHaveValue('Draft');
				await expect(selectedDraft).toHaveAttribute('aria-current', 'page');
				expect(await sidebarViewport.evaluate(element => element.scrollTop)).toBe(top);
				if (version === 'first') await expect(search).toBeFocused();
				else await expect(selectedDraft).toBeFocused();
				await page.evaluate(() => { globalThis.uiHotReloadEvidence.previousButton!.click(); });
				expect(await page.evaluate(() => !globalThis.uiHotReloadEvidence.previous.isConnected)).toBe(true);
				expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.opened)).toEqual(['chat']);
			}
			await selectedDraft.press('Enter');
			expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.opened)).toEqual(['chat', 'draft-3']);
			const sidebarTop = await sidebarViewport.evaluate(element => element.scrollTop);
			await page.evaluate(() => { globalThis.uiHotReloadEvidence.sidebar.setVisible(false); globalThis.uiHotReloadEvidence.editor.focus(); });
			await expect(host.locator('.ash-sessions-list')).toHaveCount(0);
			const updates = await page.evaluate(() => globalThis.hotReloadUpdateCount);
			await patch('sidebar', "this.domNode.className = 'ash-sessions-list';", 'this.domNode.dataset.hotReloadVersion', 'hidden');
			await expect.poll(() => page.evaluate(() => globalThis.hotReloadUpdateCount)).toBeGreaterThan(updates);
			await expect(host.locator('.ash-sessions-list')).toHaveCount(0);
			expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.editor.hasTextFocus())).toBe(true);
			await page.evaluate(() => { globalThis.uiHotReloadEvidence.sidebar.setVisible(true); });
			await expect(host.locator('.ash-sessions-list')).toHaveAttribute('data-hot-reload-version', 'hidden');
			await expect(search).toHaveValue('Draft');
			expect(await sidebarViewport.evaluate(element => element.scrollTop)).toBe(sidebarTop);
			expect(await page.evaluate(() => globalThis.uiHotReloadEvidence.editor.hasTextFocus())).toBe(true);
			const retained = await page.evaluate(() => {
				const evidence = globalThis.uiHotReloadEvidence;
				evidence.changes.fire();
				const editor = globalThis.stanza.editor.getEditors()[0]!;
				return { document: document === evidence.document, editor: editor === evidence.editor, model: editor.getModel() === evidence.model, draft: evidence.model.getValue(), selection: editor.getSelection(), active: evidence.sidebar.element.querySelector('[aria-current="page"]')?.textContent };
			});
			expect(retained).toEqual({ document: true, editor: true, model: true, draft: 'retained composer draft', selection: { selectionStartLineNumber: 1, selectionStartColumn: 2, positionLineNumber: 1, positionColumn: 7, startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 7 }, active: 'Draft 3 (draft)' });
			await page.evaluate(() => { globalThis.uiHotReloadEvidence.scope.dispose(); });
			await expect(host).toHaveCount(0);
			expect(errors).toEqual([]);
		} finally {
			const concurrent: string[] = [];
			for (const source of sources) {
				const current = await readFile(source.file, 'utf8');
				if (current === source.written) await writeFile(source.file, source.original);
				else if (current !== source.original) concurrent.push(source.file);
			}
			if (electron) {
				await electron.evaluate(({ BrowserWindow }) => {
					for (const window of BrowserWindow.getAllWindows()) window.destroy();
				});
				await electron.close();
			}
			await browser?.close();
			await server.close();
			await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			if (concurrent.length) throw new Error(`Concurrent edits preserved: ${concurrent.join(', ')}`);
		}
	});
}

test('development DomWidget rebuilds chat tips twice while retaining draft, focus, and dismissal state', { tag: ['@browser-ui', '@electron-ui'] }, async ({ playwright }, testInfo) => {

	test.setTimeout(120_000);
	const desktopDirectory = resolve(import.meta.dirname, '../../../..');
	const sourceFile = resolve(desktopDirectory, 'src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatTipContentPart.ts');
	const original = await readFile(sourceFile, 'utf8');
	let written = original;
	const profile = await mkdtemp(join(tmpdir(), 'ash-widget-hmr-'));
	const server = await createServer({ configFile: resolve(desktopDirectory, 'build/desktop/vite/editor.vite.config.ts'), server: { port: 5196, strictPort: true } });
	let electron: ElectronApplication | undefined;
	let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
	try {
		await server.listen();
		let page: Page;
		if (testInfo.project.name === 'electron-ui') {
			const configuration = resolveElectronConfiguration({ desktopDirectory, appServerMode: 'disabled', userDataDirectory: profile });
			electron = await _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, env: configuration.env, executablePath: configuration.executablePath });
			page = await electron.firstWindow();
			await page.waitForLoadState('load');
		} else {
			browser = await playwright.chromium.launch();
			page = await browser.newPage();
		}
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('http://127.0.0.1:5196/');
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(1);
		await page.evaluate(async root => {
			const moduleUrl = (path: string): string => `/@fs/${root.replaceAll('\\', '/').replace(/^\//u, '')}/src/ash/${path}`;
			const { DisposableStore } = await import(moduleUrl('base/common/lifecycle.ts'));
			const { InstantiationService } = await import(moduleUrl('platform/instantiation/common/instantiationService.ts'));
			const { registerCodeEditorServices } = await import(moduleUrl('editor/test/browser/testCodeEditor.ts'));
			const { BrowserStorageService } = await import(moduleUrl('workbench/services/storage/browser/storageService.ts'));
			const { IStorageService } = await import(moduleUrl('platform/storage/common/storage.ts'));
			const { IChatTipService, ChatTipService } = await import(moduleUrl('workbench/contrib/chat/browser/chatTipService.ts'));
			const { ChatInputTipPresenter } = await import(moduleUrl('workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.ts'));
			const { ChatInputNoticeHost } = await import(moduleUrl('workbench/contrib/chat/browser/widget/input/chatInputNoticeHost.ts'));
			const scope = new DisposableStore();
			const services = scope.add(new InstantiationService());
			const storage = scope.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'widget-hmr', backend: localStorage, flushInterval: 0 }));
			services.registerInstance(IStorageService, storage);
			services.registerInstance(IChatTipService, scope.add(services.createInstance(ChatTipService)));
			registerCodeEditorServices(services);
			const host = document.createElement('main');
			host.id = 'widget-hot-reload-host';
			document.body.append(host);
			const editor = globalThis.stanza.editor.getEditors()[0]!;
			const model = editor.getModel()!;
			model.setValue('kept through widget reload');
			const noticeHost = scope.add(new ChatInputNoticeHost(() => editor.focus()));
			const presenter = scope.add(services.createInstance(ChatInputTipPresenter, { container: host, isEligible: () => true, focusInput: () => editor.focus() }, noticeHost)) as ChatInputTipPresenter;
			editor.focus();
			editor.setSelection({ startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 9 });
			const previous = presenter.current!.domNode;
			const previousButton = previous.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.dismissTipToolbar"] button')!;
			globalThis.widgetHotReloadEvidence = { scope, presenter, editor, model, root: editor.getDomNode(), host, document, previous, previousButton };
		}, desktopDirectory);
		const host = page.locator('#widget-hot-reload-host');
		for (const version of ['first', 'second']) {
			if (version === 'second') await host.getByRole('button', { name: 'Dismiss tip', exact: true }).focus();
			written = original.replace("this.domNode.setAttribute('role', 'note');", `this.domNode.setAttribute('role', 'note');\n\t\tthis.domNode.dataset.hotReloadVersion = '${version}';`);
			expect(written).not.toBe(original);
			const temporary = `${sourceFile}.ash-hot-reload`;
			await writeFile(temporary, written);
			await rename(temporary, sourceFile);
			await expect(host.getByRole('note')).toHaveAttribute('data-hot-reload-version', version);
			const retained = await page.evaluate(() => {
				const evidence = globalThis.widgetHotReloadEvidence;
				const previous = evidence.previous;
				// A detached button must have lost its old listener and cannot dismiss the current tip.
				evidence.previousButton.click();
				evidence.previous = evidence.presenter.current!.domNode;
				evidence.previousButton = evidence.previous.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.chat.dismissTipToolbar"] button')!;
				const editor = globalThis.stanza.editor.getEditors()[0]!;
				return { document: evidence.document === document, host: evidence.host.isConnected, editor: editor === evidence.editor, model: editor.getModel() === evidence.model, root: editor.getDomNode() === evidence.root, draft: evidence.model.getValue(), selection: editor.getSelection(), previousRemoved: !previous.isConnected, currentVisible: evidence.presenter.current!.domNode.isConnected };
			});
			expect(retained).toEqual({ document: true, host: true, editor: true, model: true, root: true, draft: 'kept through widget reload', selection: { selectionStartLineNumber: 1, selectionStartColumn: 5, positionLineNumber: 1, positionColumn: 9, startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 9 }, previousRemoved: true, currentVisible: true });
			await expect(host.getByRole('note')).toHaveCount(1);
			if (version === 'first') expect(await page.evaluate(() => globalThis.widgetHotReloadEvidence.editor.hasTextFocus())).toBe(true);
			else await expect(host.getByRole('button', { name: 'Dismiss tip', exact: true })).toBeFocused();
		}
		await host.getByRole('button', { name: 'Dismiss tip', exact: true }).press('Enter');
		await expect(host.getByRole('note')).toHaveCount(0);
		expect(await page.evaluate(() => globalThis.widgetHotReloadEvidence.editor.hasTextFocus())).toBe(true);
		await page.evaluate(() => { globalThis.widgetHotReloadEvidence.presenter.update(); });
		await expect(host.getByRole('note')).toHaveCount(0);
		await page.evaluate(() => { globalThis.widgetHotReloadEvidence.scope.dispose(); globalThis.widgetHotReloadEvidence.host.remove(); });
		expect(errors).toEqual([]);
	} finally {
		const current = await readFile(sourceFile, 'utf8');
		if (current === written) await writeFile(sourceFile, original);
		if (electron) {
			await electron.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			await electron.close();
		}
		await browser?.close();
		await server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (current !== written && current !== original) throw new Error(`Concurrent edit detected; preserve ${sourceFile}`);
	}
});

test('development Renderer replaces contribution initialization twice while retaining its editor and model', { tag: ['@browser-ui', '@electron-ui'] }, async ({ playwright }, testInfo) => {

	test.setTimeout(120_000);
	const desktopDirectory = resolve(import.meta.dirname, '../../../..');
	const sourceFile = resolve(desktopDirectory, 'src/ash/editor/contrib/placeholderText/browser/placeholderTextContribution.ts');
	const original = await readFile(sourceFile, 'utf8');
	let written = original;
	const server = spawn(process.execPath, [resolve(desktopDirectory, 'node_modules/vite/bin/vite.js'), '--config', 'build/desktop/vite/editor.vite.config.ts', '--port', '5198', '--strictPort'], { cwd: desktopDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let serverOutput = '';
	server.stdout.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
	server.stderr.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
	const profile = await mkdtemp(join(tmpdir(), 'ash-hmr-'));
	let electron: ElectronApplication | undefined;
	let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
	try {
		await test.step('start the development server', async () => {
			await expect.poll(() => {
				if (server.exitCode !== null) throw new Error(serverOutput);
				return serverOutput.includes('5198');
			}, { timeout: 30_000 }).toBe(true);
		});
		let page: Page;
		if (testInfo.project.name.startsWith('electron')) {
			const configuration = resolveElectronConfiguration({ desktopDirectory, appServerMode: 'disabled', userDataDirectory: profile });
			electron = await test.step('launch the Ash Electron host', () => _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, env: configuration.env, executablePath: configuration.executablePath, timeout: 30_000 }));
			page = await test.step('wait for the first window', () => electron!.firstWindow({ timeout: 30_000 }));
			await test.step('wait for the Electron host navigation to finish', () => page.waitForLoadState('load', { timeout: 30_000 }));
		} else {
			browser = await playwright.chromium.launch();
			page = await browser.newPage();
		}
		const errors: string[] = [];
		const consoleMessages: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => consoleMessages.push(message.text()));
		await test.step('open the editor through Vite', async () => {
			try {
				await page.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
			} catch (error) {
				throw new Error(`Vite navigation failed: ${serverOutput}\n${errors.join('\n')}`, { cause: error });
			}
		});
		await test.step('wait for the placeholder contribution', async () => {
			try {
				await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(1);
			} catch (error) {
				throw new Error(`Editor startup failed: ${errors.join('\n')}\n${await page.locator('body').innerText()}`, { cause: error });
			}
		});
		await page.evaluate(async () => {
			const clientUrl = '/@vite/client';
			const client = await import(clientUrl);
			globalThis.hotReloadUpdateCount = 0;
			client.createHotContext('/ash-hmr-evidence').on('vite:afterUpdate', () => globalThis.hotReloadUpdateCount++);
			const editor = globalThis.stanza.editor.getEditors()[0]!;
			const model = editor.getModel()!;
			model.setValue('kept through reload');
			editor.setPosition({ lineNumber: 1, column: 5 });
			editor.focus();
			globalThis.hotReloadEvidence = { editor, model, root: editor.getDomNode(), document, previous: document.querySelector('.stanza-editor-placeholder-text') };
		});
		for (const version of ['first', 'second']) {
			const updates = await page.evaluate(() => globalThis.hotReloadUpdateCount);
			written = original.replace('this.element = element;', `this.element = element;\n\t\telement.dataset.hotReloadVersion = '${version}';`);
			expect(written).not.toBe(original);
			// Match an editor's atomic save rather than exposing a truncated module to the watcher.
			const temporary = `${sourceFile}.ash-hot-reload`;
			await writeFile(temporary, written);
			await rename(temporary, sourceFile);
			try {
				await expect(page.locator('.stanza-editor-placeholder-text')).toHaveAttribute('data-hot-reload-version', version);
			} catch (error) {
				throw new Error(`Hot update failed (${version}, completed: ${await page.evaluate(() => globalThis.hotReloadUpdateCount)}):\n${serverOutput}\n${consoleMessages.join('\n')}\n${errors.join('\n')}`, { cause: error });
			}
			await expect.poll(() => page.evaluate(() => globalThis.hotReloadUpdateCount)).toBe(updates + 1);
			const retained = await page.evaluate(() => {
				const evidence = globalThis.hotReloadEvidence;
				const editor = globalThis.stanza.editor.getEditors()[0]!;
				const previousRemoved = !evidence.previous!.isConnected;
				evidence.previous = document.querySelector('.stanza-editor-placeholder-text');
				return { document: document === evidence.document, editor: editor === evidence.editor, model: editor.getModel() === evidence.model, root: editor.getDomNode() === evidence.root, text: evidence.model.getValue(), position: editor.getPosition(), focus: editor.hasTextFocus(), previousRemoved };
			});
			expect(retained).toEqual({ document: true, editor: true, model: true, root: true, text: 'kept through reload', position: { lineNumber: 1, column: 5 }, focus: true, previousRemoved: true });
			await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(1);
		}
		await page.evaluate(() => globalThis.hotReloadEvidence.model.setValue(''));
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveText('Start typing…');
		await expect(page.locator('.stanza-editor-placeholder-text')).toBeVisible();
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveAttribute('aria-hidden', 'true');
		await page.evaluate(() => globalThis.hotReloadEvidence.editor.dispose());
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		// Do not overwrite an edit made by someone else while this scenario was running.
		const current = await readFile(sourceFile, 'utf8');
		if (current === written) {
			await writeFile(sourceFile, original);
		}
		if (electron) {
			await electron.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			await electron.close();
		}
		await browser?.close();
		if (server.exitCode === null) {
			const stopped = once(server, 'exit');
			server.kill();
			await stopped;
		}
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (current !== written && current !== original) {
			throw new Error(`Concurrent edit detected; preserve ${sourceFile}`);
		}
	}
});

test('development Sessions applies successive CSS saves without reloading its page', { tag: ['@browser-ui', '@electron-ui'] }, async ({ playwright }, testInfo) => {

	test.setTimeout(120_000);
	const desktopDirectory = resolve(import.meta.dirname, '../../../..');
	const stylesheetPath = 'sessions/browser/parts/media/titlebarpart.css';
	const sourceFile = resolve(desktopDirectory, 'src/ash', stylesheetPath);
	const original = await readFile(sourceFile, 'utf8');
	let written = original;
	const isBrowser = testInfo.project.name === 'browser-ui';
	const profile = await mkdtemp(join(tmpdir(), 'ash-css-hmr-'));
	let electron: ElectronApplication | undefined;
	let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
	const warmupErrors: string[] = [];
	const logger = createLogger();
	const logError = logger.error.bind(logger);
	logger.error = (message, options) => {
		if (message.includes('Pre-transform error')) warmupErrors.push(message);
		logError(message, options);
	};
	const server = await createServer({
		configFile: resolve(desktopDirectory, 'build/desktop/vite/vite.config.ts'),
		mode: isBrowser ? 'web' : 'development',
		customLogger: logger,
		server: { port: 5197, strictPort: true },
	});
	try {
		await server.listen();
		let page: Page;
		if (isBrowser) {
			browser = await playwright.chromium.launch();
			page = await browser.newPage();
			await page.goto('http://127.0.0.1:5197/browser/sessions/sessions.html');
		} else {
			const configuration = resolveElectronConfiguration({ desktopDirectory, appServerMode: 'disabled', userDataDirectory: profile });
			electron = await _electron.launch({
				args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath,
				env: { ...configuration.env, ASH_RENDERER_URL: 'http://127.0.0.1:5197', ASH_DEV_AGENTS_WINDOW: '1' },
			});
			page = await electron.firstWindow();
		}
		// CSS delivery should not depend on the configured navigation presentation.
		const titlebar = page.locator('.ash-sessions-titlebar-left');
		await expect(titlebar).toBeVisible();
		const stylesheet = page.locator(`link[rel="stylesheet"][href*="/${stylesheetPath}"]`);
		await expect(page.locator('script[type="importmap"]')).toHaveCount(1);
		await expect(stylesheet).toHaveCount(1);
		await expect(page.locator('style[data-vite-dev-id$="titlebarpart.css"]')).toHaveCount(0);
		await page.evaluate(() => { document.body.dataset.cssHotReloadRetained = 'true'; });
		for (const size of ['18px', '20px']) {
			written = `${original}\n.ash-sessions-titlebar-left { column-gap: ${size}; }\n`;
			if (size === '18px') {
				const temporary = `${sourceFile}.ash-hot-reload`;
				await writeFile(temporary, written);
				await rename(temporary, sourceFile);
			} else {
				await writeFile(sourceFile, `${original}\n.ash-sessions-titlebar-left { column-gap: 19px; }\n`);
				await writeFile(sourceFile, written);
			}
			await expect(titlebar).toHaveCSS('column-gap', size);
			await expect(stylesheet).toHaveCount(1);
			await expect(page.locator('body')).toHaveAttribute('data-css-hot-reload-retained', 'true');
			await expect(titlebar).toBeVisible();
		}
		expect(warmupErrors).toEqual([]);
	} finally {
		const current = await readFile(sourceFile, 'utf8');
		if (current === written) await writeFile(sourceFile, original);
		if (electron) {
			await electron.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			await electron.close();
		}
		await browser?.close();
		await server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (current !== written && current !== original) throw new Error(`Concurrent edit detected; preserve ${sourceFile}`);
	}
});

test('development CSS imports load and deduplicate in a plain ESM page', { tag: ['@browser-ui', '@electron-ui'] }, async ({ playwright }, testInfo) => {

	const desktopDirectory = resolve(import.meta.dirname, '../../../..');
	const template = await readFile(resolve(desktopDirectory, 'src/ash/code/browser/workbench/workbench-dev.html'), 'utf8');
	const prelude = template.replace('{{WORKBENCH_DEV_CSS_MODULES}}', JSON.stringify([
		{ specifiers: ['/loaded.css'], stylesheet: '/loaded.css' },
		{ specifiers: ['/unused.css'], stylesheet: '/unused.css' },
	]));
	const requests: string[] = [];
	const server = createHttpServer((request, response) => {
		requests.push(request.url!);
		if (request.url === '/loaded.css') {
			response.setHeader('Content-Type', 'text/css');
			response.end('.css-test { width: 37px; }');
		} else if (request.url === '/entry.js' || request.url === '/second.js') {
			response.setHeader('Content-Type', 'text/javascript');
			response.end('import "./loaded.css"; document.body.dataset.loaded = "true";');
		} else if (request.url === '/') {
			response.setHeader('Content-Type', 'text/html');
			response.end(`<html><head>${prelude}</head><body><div class="css-test"></div><script type="module" src="/entry.js"></script></body></html>`);
		} else {
			response.statusCode = 404;
			response.end();
		}
	});
	const profile = await mkdtemp(join(tmpdir(), 'ash-css-esm-'));
	let electron: ElectronApplication | undefined;
	let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
	try {
		await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
		const address = server.address();
		expect(address && typeof address !== 'string').toBeTruthy();
		const origin = `http://127.0.0.1:${(address as { port: number; }).port}`;
		let page: Page;
		if (testInfo.project.name === 'electron-ui') {
			const configuration = resolveElectronConfiguration({ desktopDirectory, appServerMode: 'disabled', userDataDirectory: profile });
			electron = await _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath, env: configuration.env });
			page = await electron.firstWindow();
			await page.waitForLoadState('load');
		} else {
			browser = await playwright.chromium.launch();
			page = await browser.newPage();
		}
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(origin);
		await expect(page.locator('body')).toHaveAttribute('data-loaded', 'true');
		await expect(page.locator('.css-test')).toHaveCSS('width', '37px');
		await page.evaluate(async () => {
			const module = '/second.js';
			await import(module);
		});
		await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
		expect(requests.filter(url => url === '/loaded.css')).toHaveLength(1);
		expect(requests).not.toContain('/unused.css');
		expect(errors).toEqual([]);
	} finally {
		if (electron) {
			await electron.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			await electron.close();
		}
		await browser?.close();
		server.closeAllConnections();
		await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
