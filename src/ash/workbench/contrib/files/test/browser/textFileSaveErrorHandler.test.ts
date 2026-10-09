import { BrowserElevatedFileService } from '../../../../services/files/browser/elevatedFileService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Event } from '../../../../../base/common/event.js';
import { DialogSeverity, type IDialogService, type IMessageDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { TextModelConflictError, TextModelSaveCompletionError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { TextFileSaveErrorHandler } from '../../browser/editors/textFileSaveErrorHandler.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

test('File save errors distinguish disk conflicts and retain the user edits', async () => {
	const messages: IMessageDialogOptions[] = [];
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => { throw new Error('Unexpected about dialog'); },
		showMessage: async options => { messages.push(options); },
		info: async () => { },
		warn: async () => { },
		error: async () => { },
		confirm: async () => { throw new Error('Unexpected confirm'); },
		prompt: async () => { throw new Error('Unexpected prompt'); },
		input: async () => { throw new Error('Unexpected input'); },
	};
	const handler = new TextFileSaveErrorHandler(dialogs, new BrowserElevatedFileService());
	const resource = URI.file('/project/notes.txt');
	await handler.onSaveError(new TextModelConflictError(resource), resource);
	assert.equal(messages[0]?.severity, DialogSeverity.Warning);
	assert.match(messages[0]?.message ?? '', /notes\.txt.*changed on disk.*unsaved changes/i);
	await handler.onSaveError(new Error('Permission denied'), resource);
	assert.equal(messages[1]?.severity, DialogSeverity.Error);
	assert.match(messages[1]?.message ?? '', /notes\.txt.*Permission denied.*unsaved changes/i);
	await handler.onSaveError(new TextModelSaveCompletionError(resource, new Error('backup transaction aborted')), resource);
	assert.equal(messages[2]?.severity, DialogSeverity.Warning);
	assert.match(messages[2]?.title ?? '', /File saved/u);
	assert.match(messages[2]?.message ?? '', /notes\.txt.*was saved.*backup transaction aborted.*retry/u);
	assert.doesNotMatch(messages[2]?.message ?? '', /Could not save/u);
	try {
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages(chinese.locale, chinese.bundles);
		await handler.onSaveError(new TextModelSaveCompletionError(resource, new Error('事务已中止')), resource);
		assert.equal(messages[3]?.title, '文件已保存，恢复备份尚未完成');
		assert.equal(messages[3]?.message, '“notes.txt”已保存，但未能完成其恢复备份：事务已中止。请再次保存以重试。本次保存之后的修改仍保留在编辑器中。');
		assert.equal(messages[3]?.severity, DialogSeverity.Warning);
	} finally {
		resetNlsResolver();
	}
});

test('only a supported system permission error offers an explicit elevated retry in Chinese', async () => {
	const { FileSystemProviderErrorCode, createFileSystemProviderError } = await import('../../../../../platform/files/common/files.js');
	const confirmations: { title?: string; message: string; detail?: string; buttons: string[]; }[] = [];
	let retries = 0;
	let messages = 0;
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None, onDidShowDialog: Event.None,
		showMessage: async () => { messages++; }, info: async () => { }, warn: async () => { }, error: async () => { }, about: async () => { },
		confirm: async () => ({ confirmed: false }),
		prompt: async options => { confirmations.push({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons.map(button => button.label) }); return { result: await options.buttons[0]!.run({}) }; }, input: async () => ({ confirmed: false }),
	};
	const handler = new TextFileSaveErrorHandler(dialogs, { isSupported: () => true, writeFileElevated: async () => { throw new Error('Handler must use the model save callback'); } });
	const resource = URI.file('/project/notes.txt');
	const permission = createFileSystemProviderError('localized by provider', FileSystemProviderErrorCode.NoPermissions);
	setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		assert.equal(await handler.onSaveError(permission, resource, async () => { retries++; }), true);
		assert.deepEqual({ retries, messages, confirmation: confirmations[0] }, {
			retries: 1, messages: 0, confirmation: {
				title: '使用管理员权限保存', message: '操作系统阻止了保存“notes.txt”。是否请求管理员权限并重试？',
				detail: '系统将请求授权。如果取消或保存失败，未保存的修改仍保留在编辑器中。', buttons: ['使用管理员权限重试'],
			}
		});
	} finally { resetNlsResolver(); }
	await handler.onSaveError(new Error('Ash directory grant denied'), resource, async () => { retries++; });
	const browserHandler = new TextFileSaveErrorHandler(dialogs, new BrowserElevatedFileService());
	await browserHandler.onSaveError(permission, resource, async () => { retries++; });
	assert.deepEqual({ confirmations: confirmations.length, retries, messages }, { confirmations: 1, retries: 1, messages: 2 });
});

test('declining elevated retry preserves the failed save and never starts a write', async () => {
	const { FileSystemProviderErrorCode, createFileSystemProviderError } = await import('../../../../../platform/files/common/files.js');
	let retries = 0;
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None, onDidShowDialog: Event.None,
		showMessage: async () => { }, info: async () => { }, warn: async () => { }, error: async () => { }, about: async () => { },
		confirm: async () => ({ confirmed: false }), prompt: async () => ({}), input: async () => ({ confirmed: false }),
	};
	const handler = new TextFileSaveErrorHandler(dialogs, { isSupported: () => true, writeFileElevated: async () => { throw new Error('Unexpected write'); } });
	assert.equal(await handler.onSaveError(createFileSystemProviderError('system denied', FileSystemProviderErrorCode.NoPermissions), URI.file('/project/notes.txt'), async () => { retries++; }), false);
	assert.equal(retries, 0);
});


test('read-only overwrite uses ordinary permissions before an explicit administrator retry', async () => {
	const { FileSystemProviderErrorCode, createFileSystemProviderError } = await import('../../../../../platform/files/common/files.js');
	const requests: import('../../../../common/editor.js').ISaveOptions[] = [];
	const choices: string[][] = [];
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None, onDidShowDialog: Event.None,
		showMessage: async () => { throw new Error('Unexpected message'); }, info: async () => { }, warn: async () => { }, error: async () => { }, about: async () => { },
		confirm: async () => ({ confirmed: false }), input: async () => ({ confirmed: false }),
		prompt: async options => { choices.push(options.buttons.map(button => button.label)); return { result: await options.buttons[0]!.run({}) }; },
	};
	const handler = new TextFileSaveErrorHandler(dialogs, { isSupported: () => true, writeFileElevated: async () => { throw new Error('Unexpected service write'); } });
	const result = await handler.onSaveError(createFileSystemProviderError('locked', FileSystemProviderErrorCode.FileWriteLocked), URI.file('/project/notes.txt'), async options => {
		requests.push(options);
		if (options.unlock) { throw createFileSystemProviderError('system denied', FileSystemProviderErrorCode.NoPermissions); }
	}, { saveAs: async () => false, revert: async () => { } });
	assert.deepEqual({ result, requests, choices }, {
		result: true,
		requests: [{ unlock: true, skipSaveParticipants: true }, { writeElevated: true, skipSaveParticipants: true }],
		choices: [['Overwrite', 'Save As...', 'Revert'], ['Retry with administrator permission', 'Save As...', 'Revert']],
	});
});

test('save recovery can cancel Save As or explicitly revert without requesting elevation', async () => {
	let selected = 0;
	let reverted = 0;
	const choices: string[][] = [];
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None, onDidShowDialog: Event.None,
		showMessage: async () => { throw new Error('Unexpected message'); }, info: async () => { }, warn: async () => { }, error: async () => { }, about: async () => { },
		confirm: async () => ({ confirmed: false }), input: async () => ({ confirmed: false }),
		prompt: async options => { choices.push(options.buttons.map(button => button.label)); return { result: await options.buttons[selected]!.run({}) }; },
	};
	const handler = new TextFileSaveErrorHandler(dialogs, new BrowserElevatedFileService());
	const recovery = { saveAs: async () => false, revert: async () => { reverted++; } };
	assert.equal(await handler.onSaveError(new Error('save failed'), URI.file('/project/notes.txt'), undefined, recovery), false);
	selected = 1;
	assert.equal(await handler.onSaveError(new Error('save failed'), URI.file('/project/notes.txt'), undefined, recovery), true);
	assert.deepEqual({ reverted, choices }, { reverted: 1, choices: [['Save As...', 'Revert'], ['Save As...', 'Revert']] });
});
