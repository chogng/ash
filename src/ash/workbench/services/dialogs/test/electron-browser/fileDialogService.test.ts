import { IQuickInputService, type IQuickInputService as QuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { IHostService } from '../../../host/browser/host.js';
import { TestHostService } from '../../../host/test/browser/testHostService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import type { SaveDialogReturnValue } from '../../../../../base/parts/sandbox/common/electronTypes.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INativeHostService } from '../../../../common/services.js';
import { FileDialogService } from '../../electron-browser/fileDialogService.js';
import { DialogService } from '../../common/dialogService.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import chineseMessages from '../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

test('Save As passes the suggested file name to the owning desktop window', async () => {
	const calls: Array<{ readonly defaultPath?: string; } | undefined> = [];
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'test' });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IHostService, new TestHostService());
	services.registerInstance(IDialogService, new DialogService());
	services.registerInstance(INativeHostService, {
		async showSaveDialog(options) {
			calls.push(options);
			return { canceled: false, filePath: 'C:\\Users\\test\\report.txt' };
		},
	} as INativeHostApi);
	const service = services.createInstance(FileDialogService);

	assert.deepEqual(await service.pickFileToSave(URI.file('/report.txt')), URI.file('C:\\Users\\test\\report.txt'));
	assert.deepEqual(calls, [{ defaultPath: 'report.txt', title: 'Save File' }]);
});

test('cancelling the desktop Save As dialog leaves the editor without a target', async () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'test' });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IHostService, new TestHostService());
	services.registerInstance(IDialogService, new DialogService());
	services.registerInstance(INativeHostService, {
		async showSaveDialog(): Promise<SaveDialogReturnValue> { return { canceled: true, filePath: '' }; },
	} as unknown as INativeHostApi);
	const service = services.createInstance(FileDialogService);

	assert.equal(await service.pickFileToSave(URI.file('/report.txt')), undefined);
});

test('desktop Open File returns the path selected by its window', async () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'test' });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IHostService, new TestHostService());
	services.registerInstance(IDialogService, new DialogService());
	services.registerInstance(INativeHostService, {
		async showOpenDialog() { return { canceled: false, filePaths: ['C:\\Users\\test\\paper.md'] }; },
	} as unknown as INativeHostApi);
	const service = services.createInstance(FileDialogService);

	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: true, canSelectFolders: false }), [URI.file('C:\\Users\\test\\paper.md')]);
});

test('desktop open and save dialogs pass VS Code file options through to the window', async () => {
	const calls: unknown[] = [];
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'test' });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IHostService, new TestHostService());
	services.registerInstance(IDialogService, new DialogService());
	services.registerInstance(INativeHostService, {
		async showOpenDialog(options: unknown) { calls.push(options); return { canceled: false, filePaths: ['C:\\work\\one.md', 'C:\\work\\two.md'] }; },
		async showSaveDialog(options: unknown) { calls.push(options); return { canceled: false, filePath: 'C:\\work\\report.md' }; },
	} as unknown as INativeHostApi);
	const service = services.createInstance(FileDialogService);
	const filters = [{ name: 'Markdown', extensions: ['md'] }];
	const folder = URI.parse('file:///C:/work');
	const report = URI.parse('file:///C:/work/report.md');
	assert.deepEqual(await service.showOpenDialog({ title: 'Choose', openLabel: 'Import', defaultUri: folder, canSelectMany: true, filters }), [URI.file('C:\\work\\one.md'), URI.file('C:\\work\\two.md')]);
	assert.deepEqual(await service.showSaveDialog({ title: 'Export', saveLabel: 'Write', defaultUri: report, filters }), URI.file('C:\\work\\report.md'));
	assert.deepEqual(calls, [
		{ properties: ['openFile', 'multiSelections'], defaultPath: folder.fsPath, title: 'Choose', buttonLabel: 'Import', filters },
		{ defaultPath: report.fsPath, title: 'Export', buttonLabel: 'Write', filters },
	]);
	await assert.rejects(service.showOpenDialog({ canSelectFiles: false, canSelectFolders: false }), /must allow files or folders/);
	await assert.rejects(service.showSaveDialog({ availableFileSystems: ['other'] }), /file scheme only/);
});

test('desktop file dialogs keep cancellation distinct from returned paths and localize default titles', async () => {
	const calls: unknown[] = [];
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'test' });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IHostService, new TestHostService());
	services.registerInstance(IDialogService, new DialogService());
	services.registerInstance(INativeHostService, {
		async showOpenDialog(options) { calls.push(options); return { canceled: true, filePaths: ['/ignored.md'] }; },
		async showSaveDialog(options) { calls.push(options); return { canceled: true, filePath: '/ignored.md' }; },
	} as INativeHostApi);
	const service = services.createInstance(FileDialogService);
	setNlsMessages('zh-CN', chineseMessages);
	try {
		assert.equal(await service.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }), undefined);
		assert.equal(await service.showSaveDialog({}), undefined);
		assert.deepEqual(calls, [{ properties: ['openDirectory'], title: '打开文件' }, { title: '保存文件' }]);
	} finally {
		resetNlsResolver();
	}
});


for (const locale of ['en', 'zh-CN']) test(`Remote Add Folder keeps its authority and client language (${locale})`, async () => {
	if (locale === 'zh-CN') setNlsMessages('zh-CN', chineseMessages);
	try {
		using services = new InstantiationService();
		using workspace = new TestWorkspaceService({ id: 'remote', uri: createSshRemoteWorkspaceUri('test-host', '/remote/client') });
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IHostService, new TestHostService());
		services.registerInstance(IDialogService, new DialogService());
		services.registerInstance(INativeHostService, { showOpenDialog: async () => { throw new Error('Remote folder picker must not open the local OS chooser'); } } as unknown as INativeHostApi);
		services.registerInstance(IQuickInputService, {
			input: async options => {
				assert.equal(options.value, '/remote/client');
				assert.equal(await options.validateInput?.('relative'), locale === 'en' ? 'Enter an absolute folder path on the current remote host.' : '输入当前远端主机上的绝对文件夹路径。');
				assert.equal(await options.validateInput?.('/remote/server'), undefined);
				return '/remote/server';
			},
		} as QuickInputService);
		const dialogs = services.createInstance(FileDialogService);
		const result = await dialogs.showOpenDialog({ canSelectFiles: false, canSelectFolders: true });
		assert.deepEqual(result, [createSshRemoteWorkspaceUri('test-host', '/remote/server')]);
	} finally { resetNlsResolver(); }
});
