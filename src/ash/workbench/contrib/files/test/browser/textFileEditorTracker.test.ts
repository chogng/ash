import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { getBrowserTextResourceStore } from '../../../codeEditor/browser/browserTextResourceStore.js';
import { getBrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextFileContentSource } from '../../../../services/textfile/common/textFileService.js';
import { type ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { TextFileEditorTracker } from '../../browser/editors/textFileEditorTracker.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';

test('File editor tracker reloads clean visible files after window focus and keeps dirty edits', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const resource = URI.file('C:\\project\\notes.txt');
	let diskText = 'first';
	let revision = 1;
	let reads = 0;
	const textFiles: ITextFileService = {
		onDidSave: Event.None,
		onDidChangeFiles: Event.None,
		resolve: async request => {
			reads++;
			return { resource: request.resource, text: diskText, source: TextFileContentSource.FileSystem, revision: String(revision), encoding: 'utf8' };
		},
		save: async () => { throw new Error('Unexpected save'); },
	};
	using services = new TestUriIdentityServices();
	using models = getBrowserTextModelService(getBrowserTextResourceStore(textFiles), services);
	using reference = await models.acquire({ resource }, new AbortController().signal);
	const editorService = {
		...emptyEditorServiceState,
		visibleEditors: [{ resource }],
		openEditor: async () => { },
		focusActiveEditor: () => { },
	};
	using tracker = new TextFileEditorTracker(browser.window as unknown as Window, editorService, models);

	diskText = 'second';
	revision += 1;
	browser.window.dispatchEvent(new browser.window.Event('focus'));
	await waitFor(() => reference.model.getText() === 'second');
	assert.equal(reference.hasExternalChange, false);

	reference.model.applyEdits([{ range: Range.fromPositions(new Position(1, 1), new Position(1, 7)), text: 'mine' }]);
	diskText = 'third';
	revision += 1;
	browser.window.dispatchEvent(new browser.window.Event('focus'));
	await models.refresh(resource);
	assert.deepEqual([reference.model.getText(), reference.isDirty, reference.hasExternalChange, reads], ['mine', true, false, 2]);
	browser.window.close();
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for file refresh');
}
