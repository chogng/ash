import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { DialogSeverity, type IDialogService, type IMessageDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { TextModelConflictError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { TextFileSaveErrorHandler } from '../../browser/editors/textFileSaveErrorHandler.js';

test('File save errors distinguish disk conflicts and retain the user edits', async () => {
	const messages: IMessageDialogOptions[] = [];
	const dialogs: IDialogService = {
		showMessage: async options => { messages.push(options); },
		confirm: async () => { throw new Error('Unexpected confirm'); },
		prompt: async () => { throw new Error('Unexpected prompt'); },
		input: async () => { throw new Error('Unexpected input'); },
	};
	const handler = new TextFileSaveErrorHandler(dialogs);
	const resource = URI.file('C:\\project\\notes.txt');
	await handler.onSaveError(new TextModelConflictError(resource), resource);
	assert.equal(messages[0]?.severity, DialogSeverity.Warning);
	assert.match(messages[0]?.message ?? '', /notes\.txt.*changed on disk.*unsaved changes/i);
	await handler.onSaveError(new Error('Permission denied'), resource);
	assert.equal(messages[1]?.severity, DialogSeverity.Error);
	assert.match(messages[1]?.message ?? '', /notes\.txt.*Permission denied.*unsaved changes/i);
});
