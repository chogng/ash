import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AddRootFolderAction, RemoveRootFolderAction, SaveWorkspaceAsAction } from '../../../../browser/actions/workspaceActions.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { WorkspaceEditingService } from '../../electron-browser/workspaceEditingService.js';
import { WorkspaceContextService } from '../../browser/workspaceContextService.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';
import { resetNlsResolver } from '../../../../../nls.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('local workspace management uses the Chinese client translations', async () => {
	await initializeTestLocalization('zh-CN');
	try {
		const titles = [new AddRootFolderAction(), new RemoveRootFolderAction(), new SaveWorkspaceAsAction()].map(action => {
			const title = action.desc.title;
			return typeof title === 'string' ? title : title.value;
		});
		assert.deepEqual(titles, ['将文件夹添加到工作区...', '从工作区移除文件夹...', '将工作区另存为...']);
	} finally { resetNlsResolver(); }
});


test('folder validation keeps dirty files accessible until saved or reverted', async () => {
	const first = { id: 'one', name: 'one', uri: URI.file('/first'), index: 0 };
	const second = { id: 'two', name: 'two', uri: URI.file('/second'), index: 1 };
	using context = new WorkspaceContextService({ id: 'team', folders: [first, second], configuration: URI.file('/team.ash-workspace') });
	let dirty = true;
	const copies = { getAll: () => [{ resource: URI.file('/second/src/unsaved.ts'), isDirty: dirty }] } as unknown as IWorkingCopyService;
	const editing = new WorkspaceEditingService({ getWorkspace: async () => ({}), onDidChange: () => ({ dispose() { } }) }, context, {} as IFileDialogService, copies);
	assert.throws(() => editing.validateFolders([first.uri]), /Save or revert/);
	assert.doesNotThrow(() => editing.validateFolders([first.uri, second.uri]));
	assert.throws(() => editing.validateFolders([URI.file('/')]), /Save or revert/);
	assert.throws(() => editing.validateFolders([first.uri, second.uri, URI.file('/second/src')]), /Save or revert/);
	await initializeTestLocalization('zh-CN');
	try { assert.throws(() => editing.validateFolders([first.uri]), /请先保存或还原/); }
	finally { resetNlsResolver(); }
	dirty = false;
	assert.doesNotThrow(() => editing.validateFolders([first.uri]));
});
