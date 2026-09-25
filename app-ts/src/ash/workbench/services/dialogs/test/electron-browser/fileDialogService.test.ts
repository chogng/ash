import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../common/services.js';
import { FileDialogService } from '../../electron-browser/fileDialogService.js';

test('Save As passes the suggested file name to the owning desktop window', async () => {
	const calls: Array<{ readonly defaultName?: string } | undefined> = [];
	using services = new ServiceContainer();
	services.registerInstance(INativeHostService, {
		async saveFile(options) {
			calls.push(options);
			return 'C:\\Users\\test\\report.txt';
		},
	} as INativeHostApi);
	const service = services.createInstance(FileDialogService);

	assert.deepEqual(await service.pickFileToSave(URI.file('/report.txt')), URI.file('C:\\Users\\test\\report.txt'));
	assert.deepEqual(calls, [{ defaultName: 'report.txt' }]);
});

test('cancelling the desktop Save As dialog leaves the editor without a target', async () => {
	using services = new ServiceContainer();
	services.registerInstance(INativeHostService, {
		async saveFile() { return undefined; },
	} as INativeHostApi);
	const service = services.createInstance(FileDialogService);

	assert.equal(await service.pickFileToSave(URI.file('/report.txt')), undefined);
});

test('desktop Open File returns the path selected by its window', async () => {
	using services = new ServiceContainer();
	services.registerInstance(INativeHostService, {
		async pickFile() { return ['C:\\Users\\test\\paper.md']; },
	} as unknown as INativeHostApi);
	const service = services.createInstance(FileDialogService);

	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: true, canSelectFolders: false }), [URI.file('C:\\Users\\test\\paper.md')]);
});

test('desktop open and save dialogs pass VS Code file options through to the window', async () => {
	const calls: unknown[] = [];
	using services = new ServiceContainer();
	services.registerInstance(INativeHostService, {
		async pickFile(options: unknown) { calls.push(options); return ['C:\\work\\one.md', 'C:\\work\\two.md']; },
		async saveFile(options: unknown) { calls.push(options); return 'C:\\work\\report.md'; },
	} as unknown as INativeHostApi);
	const service = services.createInstance(FileDialogService);
	const filters = [{ name: 'Markdown', extensions: ['md'] }];
	assert.deepEqual(await service.showOpenDialog({ title: 'Choose', openLabel: 'Import', defaultUri: URI.file('C:\\work'), canSelectMany: true, filters }), [URI.file('C:\\work\\one.md'), URI.file('C:\\work\\two.md')]);
	assert.deepEqual(await service.showSaveDialog({ title: 'Export', saveLabel: 'Write', defaultUri: URI.file('C:\\work\\report.md'), filters }), URI.file('C:\\work\\report.md'));
	assert.deepEqual(calls, [
		{ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultPath: 'C:\\work', title: 'Choose', buttonLabel: 'Import', filters },
		{ defaultPath: 'C:\\work\\report.md', title: 'Export', buttonLabel: 'Write', filters },
	]);
	await assert.rejects(service.showOpenDialog({ canSelectFiles: false, canSelectFolders: false }), /must allow files or folders/);
	await assert.rejects(service.showSaveDialog({ availableFileSystems: ['other'] }), /file scheme only/);
});
