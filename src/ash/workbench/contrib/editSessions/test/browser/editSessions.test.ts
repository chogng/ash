import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { setNlsMessages } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService, type IFileWriteOptions } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { createDisconnectedLocalGitService } from '../../../../../platform/git/browser/appServerLocalGitService.js';
import { ILocalGitService, type GitWorktreeEditSnapshot } from '../../../../../platform/git/common/localGitService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { UserDataProfileService } from '../../../../services/userDataProfile/browser/userDataProfileService.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { isMultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import '../../browser/editSessions.contribution.js';
import { EditSessionsFileSystemProvider } from '../../browser/editSessionsFileSystemProvider.js';

const store = 'workbench.editSessions.actions.storeCurrent';
const resume = 'workbench.editSessions.actions.resumeLatest';
const review = 'workbench.editSessions.actions.showEditSessions';
const discard = 'workbench.editSessions.actions.discardLocal';
const source = URI.file('/source');
const target = URI.file('/target');
const identity = { repositoryId: 'a'.repeat(64), head: 'b'.repeat(40) };
const bytes = (text: string) => new TextEncoder().encode(text);
const binary = Uint8Array.of(0, 0xff, 9);
const sourceSnapshot: GitWorktreeEditSnapshot = {
	...identity,
	unsupportedPaths: [],
	files: [
		{ path: 'modified.txt', originalPath: null, original: bytes('before\n'), modified: bytes('after\n'), omitted: false },
		{ path: 'removed.txt', originalPath: null, original: bytes('delete me'), modified: null, omitted: false },
		{ path: 'new/added.bin', originalPath: null, original: null, modified: binary, omitted: false },
	],
};

class TestFiles extends InMemoryFileSystemProvider {
	failWrite: URI | undefined;
	onWrite: (() => Promise<void>) | undefined;

	override async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions, signal?: AbortSignal) {
		if (this.failWrite?.toString() === resource.toString()) throw new Error('Test write failed');
		const result = await super.writeFile(resource, content, options, signal);
		await this.onWrite?.();
		return result;
	}
}

async function setup(resources: DisposableStore, lineEnding = '\n') {
	const files = resources.add(new FileService());
	const workspaceFiles = resources.add(new TestFiles());
	const profileFiles = resources.add(new InMemoryFileSystemProvider());
	const profiles = new UserDataProfileService();
	resources.add(files.registerProvider('file', workspaceFiles));
	resources.add(files.registerProvider(profiles.currentProfile.location.scheme, profileFiles));
	await files.createDirectory(URI.joinPath(source, 'new'));
	await files.createDirectory(target);
	await files.writeFileBytes(URI.joinPath(source, 'modified.txt'), bytes(`after${lineEnding}`));
	await files.writeFileBytes(URI.joinPath(source, 'new/added.bin'), binary);
	await files.writeFileBytes(URI.joinPath(target, 'modified.txt'), bytes(`before${lineEnding}`));
	await files.writeFileBytes(URI.joinPath(target, 'removed.txt'), bytes('delete me'));
	const notices: string[] = [];
	const warnings: string[] = [];
	const confirmations: IConfirmationDialogOptions[] = [];
	const opened: IResourceEditorInput[] = [];
	let head = identity.head;
	let changedPaths: readonly string[] = [];
	let confirm: () => boolean | Promise<boolean> = () => true;

	function open(root: URI) {
		const services = resources.add(new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors())));
		services.registerInstance(IFileService, files);
		services.registerInstance(IUserDataProfileService, profiles);
		services.registerInstance(IWorkspaceContextService, {
			onDidChangeWorkspace: Event.None,
			getWorkspace: () => ({ folders: [{ uri: root }] }),
		} as unknown as IWorkspaceContextService);
		services.registerInstance(ILocalGitService, {
			...createDisconnectedLocalGitService(() => { throw new Error('Unexpected Git request'); }),
			readWorktreeEditStatus: async path => {
				assert.equal(path, root.fsPath);
				return { ...identity, head: path === source.fsPath ? identity.head : head, changedPaths };
			},
			readWorktreeEditSnapshot: async path => {
				assert.equal(path, source.fsPath);
				return sourceSnapshot;
			},
		});
		services.registerInstance(IEditorService, {
			saveAll: async () => ({ success: true, editors: [] }),
			openEditor: async (input: IResourceEditorInput) => { opened.push(input); },
		} as unknown as IEditorService);
		services.registerInstance(IWorkingCopyService, { get: () => [] } as unknown as IWorkingCopyService);
		services.registerInstance(INotificationService, {
			info: (value: string) => { notices.push(value); },
			error: (value: string) => { notices.push(value); },
			warn: (value: string) => { notices.push(value); },
		} as unknown as INotificationService);
		services.registerInstance(IDialogService, {
			warn: async (_message: string, detail: string) => { warnings.push(detail); },
			confirm: async (options: IConfirmationDialogOptions) => {
				confirmations.push(options);
				return { confirmed: await confirm() };
			},
		} as IDialogService);
		if (root === target) resources.add(services.createInstance(EditSessionsFileSystemProvider));
		return (id: string, ...args: unknown[]): Promise<void> => services.invokeFunction(accessor => CommandsRegistry.getCommand(id)!(accessor, ...args)) as Promise<void>;
	}

	const runSource = open(source);
	await runSource(store);
	assert.match(notices.pop() ?? '', /Working changes saved/);
	return {
		run: open(target), runSource, files, workspaceFiles, notices, warnings, confirmations, opened,
		setHead: (value: string) => { head = value; },
		setDirty: (paths: readonly string[]) => { changedPaths = paths; },
		onConfirm: (value: typeof confirm) => { confirm = value; },
	};
}

test('commands preview and restore modified, deleted and binary files across Workbench instances', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	fixture.onConfirm(() => false);
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		await fixture.run(resume);
		assert.deepEqual(fixture.confirmations.map(({ message, detail, primaryButton }) => ({ message, detail, primaryButton })), [{
			message: '要在此工作树中恢复工作改动吗？',
			detail: '修改 modified.txt\n删除 removed.txt\n新增 new/added.bin',
			primaryButton: '恢复改动',
		}]);
	} finally {
		setNlsMessages('en', {});
	}
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'before\n');
	fixture.onConfirm(() => true);
	await fixture.run(resume);
	assert.equal(fixture.notices.at(-1), 'Restored 3 working changes.');
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'after\n');
	await assert.rejects(fixture.files.stat(URI.joinPath(target, 'removed.txt')));
	assert.deepEqual((await fixture.files.readFileBytes(URI.joinPath(target, 'new/added.bin'))).bytes, binary);
	assert.equal((await fixture.files.readFile(URI.joinPath(source, 'modified.txt'))).content, 'after\n');
	await fixture.run(resume);
	assert.match(fixture.notices.at(-1) ?? '', /has no saved working changes/);
});

test('Git-normalized baselines accept CRLF and preserve the exact source bytes', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources, '\r\n');
	await fixture.run(resume);
	assert.equal(fixture.notices.at(-1), 'Restored 3 working changes.');
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'after\r\n');
});

test('a changed base or staged target file prevents even unrelated parts of the restore', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	fixture.setHead('c'.repeat(40));
	await fixture.run(resume);
	assert.match(fixture.notices.at(-1) ?? '', /Open a worktree at the commit/);
	fixture.setHead(identity.head);
	fixture.setDirty(['modified.txt']);
	await fixture.run(resume);
	assert.deepEqual(fixture.warnings, ['Modify modified.txt']);
	assert.equal(fixture.confirmations.length, 0);
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'removed.txt'))).content, 'delete me');
});

test('an external change during the confirmation is detected before writing', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	fixture.onConfirm(async () => {
		await fixture.files.writeFile({ resource: URI.joinPath(target, 'modified.txt'), content: 'external edit' });
		return true;
	});
	await fixture.run(resume);
	assert.deepEqual(fixture.warnings, ['Modify modified.txt']);
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'external edit');
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'removed.txt'))).content, 'delete me');
});

test('saved paths cannot escape the checkout or name Git metadata', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	const saved = URI.joinPath(new UserDataProfileService().currentProfile.location, 'editSessions', `${identity.repositoryId}.json`);
	for (const path of ['../outside.txt', '.GiT/config', 'dir\\..\\outside.txt']) {
		await fixture.files.writeFile({
			resource: saved,
			content: JSON.stringify({ version: 1, head: identity.head, changes: [{ path, before: null, after: '' }] }),
		});
		await fixture.run(resume);
		assert.equal(fixture.notices.at(-1), 'Could not read the saved working changes.');
	}
	assert.equal(fixture.confirmations.length, 0);
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'before\n');
	await fixture.run(discard);
	assert.equal((await fixture.files.readFileBytes(saved)).bytes.length, 0);
});

test('a later write failure rolls back earlier changes and leaves the saved session available for retry', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	fixture.workspaceFiles.failWrite = URI.joinPath(target, 'new/added.bin');
	await fixture.run(resume);
	assert.equal(fixture.notices.at(-1), 'Test write failed');
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'before\n');
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'removed.txt'))).content, 'delete me');
	fixture.workspaceFiles.failWrite = undefined;
	await fixture.run(resume);
	assert.equal(fixture.notices.at(-1), 'Restored 3 working changes.');
});

test('review opens a read-only diff with revision-bound file contents and serializes references only', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	await fixture.run(review);
	const input = fixture.opened[0]!;
	assert.ok(isMultiDiffEditorInput(input));
	assert.equal(input.readOnly, true);
	assert.equal(input.items[2]?.binary, true);
	const { original, modified } = input.items[0]!;
	assert.equal((await fixture.files.readFile(original.resource)).content, 'before\n');
	assert.equal((await fixture.files.readFile(modified.resource)).content, 'after\n');
	assert.doesNotMatch(JSON.stringify(EditorInputSerializers.serialize(input)), /initialText|YmVmb3Jl|YWZ0ZXI/);

	await fixture.runSource(store);
	const action = input.source?.kind === 'snapshot' ? input.source.actions?.[0] : undefined;
	assert.ok(action);
	await fixture.run(action.command, ...action.arguments);
	assert.match(fixture.notices.at(-1) ?? '', /changed in another window/);
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'before\n');
	await assert.rejects(fixture.files.readFile(original.resource), { name: 'FileNotFoundError' });
});

test('replacement and discard require confirmation and leave workspace files in place', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	fixture.onConfirm(() => false);
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		await fixture.runSource(store);
		await fixture.run(discard);
		await fixture.run(review);
		assert.deepEqual(fixture.confirmations.map(({ primaryButton }) => primaryButton), ['替换', '丢弃']);
		assert.equal(fixture.opened[0]?.label, '已保存的工作改动');
	} finally {
		setNlsMessages('en', {});
	}
	assert.equal(fixture.opened.length, 1);
	fixture.onConfirm(() => true);
	await fixture.run(discard);
	assert.equal(fixture.notices.at(-1), 'Saved working changes discarded.');
	await fixture.run(review);
	assert.match(fixture.notices.at(-1) ?? '', /has no saved working changes/);
	assert.equal((await fixture.files.readFile(URI.joinPath(source, 'modified.txt'))).content, 'after\n');
	assert.equal((await fixture.files.readFile(URI.joinPath(target, 'modified.txt'))).content, 'before\n');
});

test('a newer save published during restore survives cleanup of the restored revision', async () => {
	using resources = new DisposableStore();
	const fixture = await setup(resources);
	fixture.workspaceFiles.onWrite = async () => {
		fixture.workspaceFiles.onWrite = undefined;
		await fixture.runSource(store);
	};
	await fixture.run(resume);
	assert.equal(fixture.notices.at(-1), 'Restored 3 working changes.');
	await fixture.run(review);
	assert.equal(fixture.opened.length, 1);
});
