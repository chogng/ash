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
	const handler = new TextFileSaveErrorHandler(dialogs);
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
