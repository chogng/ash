import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ASH_REMOTE_SCHEME } from '../../../../../platform/remote/common/remote.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { WorkspaceFolderCountContext, IsSessionsWindowContext, ResourceSchemeContext } from '../../../../../workbench/common/contextkeys.js';
import { ViewDescriptorService } from '../../../../../workbench/services/views/common/viewDescriptorService.js';
import { ViewPaneContainer } from '../../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { FileEditorInput } from '../../../../../workbench/contrib/files/browser/editors/fileEditorInput.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { NotificationService } from '../../../../../workbench/services/notification/common/notificationService.js';
import { builtinLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { SessionsViewRegistry } from '../../../../common/views.js';
import { DownloadRemoteFileAction, SESSIONS_FILES_CONTAINER_ID } from '../../browser/files.contribution.js';
import { SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID } from '../../browser/filesView.js';

test('Sessions Files selects one view from the current folder state and creates the localized empty pane', () => {
	using contexts = new ContextKeyService();
	const folders = WorkspaceFolderCountContext.bindTo(contexts);
	using descriptors = new ViewDescriptorService({ contextKeyService: contexts, registry: SessionsViewRegistry });
	const model = descriptors.getViewContainerModel(SESSIONS_FILES_CONTAINER_ID);
	const visibleIds = (): string[] => model.visibleViewDescriptors.map(view => view.id);
	assert.deepEqual(visibleIds(), [SESSIONS_FILES_EMPTY_VIEW_ID]);
	folders.set(2);
	assert.deepEqual(visibleIds(), [SESSIONS_FILES_VIEW_ID]);
	folders.set(0);
	using services = new InstantiationService();
	const storageEnvironment = new JSDOM('<!doctype html><body></body>', { url: 'https://ash-files.test' });
	using storageOwner = toDisposable(() => storageEnvironment.window.close());
	using storage = new BrowserStorageService({ ownerWindow: browserEnvironment.window as unknown as Window, applicationId: 'sessions-files-test', workspaceId: 'empty', backend: storageEnvironment.window.localStorage, flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using host = services.createInstance(ViewPaneContainer, browserEnvironment.window.document.body, {
		viewContainer: model.viewContainer,
		model,
		instantiationService: services,
		contextKeyService: contexts,
		onDidFailCreateView: error => { throw error; },
	});
	const message = host.element.querySelector('[role="status"]');
	assert.equal(message?.textContent, 'Folders and files will appear here.');
	const catalog = builtinLanguagePackCatalogs.find(pack => pack.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, original) => catalog.bundles[bundle]?.[key] ?? original);
		assert.equal(message?.textContent, '文件夹和文件将在这里显示。');
		host.getView(SESSIONS_FILES_EMPTY_VIEW_ID)!.focus();
		assert.equal(browserEnvironment.window.document.activeElement, host.getView(SESSIONS_FILES_EMPTY_VIEW_ID)!.element);
	} finally {
		resetNlsResolver();
	}
});

test('Sessions remote download preserves selected file bytes and reports read failures', async () => {
	const browser = browserEnvironment;
	const remote = ['first.bin', 'second.bin'].map(name => URI.from({ scheme: ASH_REMOTE_SCHEME, authority: 'host', path: `/project/${name}` }));
	const inputs = [...remote, URI.file('/local.txt')].map(resource => new FileEditorInput(resource));
	const group = {
		id: 'group', inputs, selectedInputs: inputs, activeInput: inputs[0],
		editors: inputs.map(input => ({ input })),
	} as unknown as IEditorGroup;
	using services = new InstantiationService();
	using notifications = new NotificationService();
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IEditorGroupsService, { getGroup: () => group } as unknown as IEditorGroupsService);
	const reads: URI[] = [];
	const downloads: string[] = [];
	const blobs: Blob[] = [];
	let revokedCount = 0;
	let finishRevoking!: () => void;
	const revoked = new Promise<void>(resolve => { finishRevoking = resolve; });
	let fail = false;
	services.registerInstance(IFileService, {
		readFileBytes: async resource => {
			if (fail) { throw new Error('Remote file unavailable'); }
			reads.push(resource);
			return { resource, bytes: new Uint8Array([0, 255, 42]), revision: 'revision' };
		},
	} as IFileService);
	const previousCreate = browser.window.URL.createObjectURL;
	const previousRevoke = browser.window.URL.revokeObjectURL;
	const previousClick = browser.window.HTMLAnchorElement.prototype.click;
	browser.window.URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return 'blob:download'; };
	browser.window.URL.revokeObjectURL = () => {
		if (++revokedCount === remote.length) { finishRevoking(); }
	};
	browser.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
	try {
		using commands = new CommandService(services);
		await commands.executeCommand(DownloadRemoteFileAction.ID, { groupId: group.id });
		assert.deepEqual(reads, remote);
		assert.deepEqual(downloads, ['first.bin', 'second.bin']);
		await revoked;
		for (const blob of blobs) {
			assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 255, 42]);
		}
		fail = true;
		await assert.rejects(commands.executeCommand(DownloadRemoteFileAction.ID, { groupId: group.id }), /Remote file unavailable/);
		assert.deepEqual(notifications.getNotifications().map(item => item.message), ['Remote file unavailable']);
	} finally {
		browser.window.URL.createObjectURL = previousCreate;
		browser.window.URL.revokeObjectURL = previousRevoke;
		browser.window.HTMLAnchorElement.prototype.click = previousClick;
	}
});

test('Sessions remote download is available only for a remote file in the Sessions window', () => {
	using contexts = new ContextKeyService();
	const session = IsSessionsWindowContext.bindTo(contexts);
	const scheme = ResourceSchemeContext.bindTo(contexts);
	const action = new DownloadRemoteFileAction();
	for (const [isSession, resourceScheme, expected] of [[false, ASH_REMOTE_SCHEME, false], [true, 'file', false], [true, ASH_REMOTE_SCHEME, true]] as const) {
		session.set(isSession);
		scheme.set(resourceScheme);
		assert.equal(contexts.contextMatchesRules(action.desc.precondition), expected);
	}
});
