import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { getBrowserTextResourceStore } from '../../../codeEditor/browser/browserTextResourceStore.js';
import { getBrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextFileContentSource, type ITextFileService } from '../../../../services/textfile/common/textFileService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { TextFileEditorTracker } from '../../browser/editors/textFileEditorTracker.js';

test('File editor tracker reloads clean visible files after window focus and keeps dirty edits', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const resource = URI.file('C:\\project\\notes.txt');
	let diskText = 'first';
	let revision = 1;
	const textFiles: ITextFileService = {
		onDidChangeFiles: Event.None,
		resolve: async request => ({ resource: request.resource, text: diskText, source: TextFileContentSource.FileSystem, revision: String(revision), encoding: 'utf8' }),
		save: async () => { throw new Error('Unexpected save'); },
	};
	const models = getBrowserTextModelService(getBrowserTextResourceStore(textFiles));
	using reference = await models.acquire({ resource }, new AbortController().signal);
	const editorService = {
		...emptyEditorServiceState,
		visibleEditors: [{ resource }],
		openEditor: async () => {},
		focusActiveEditor: () => {},
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
	await waitFor(() => reference.hasExternalChange);
	assert.equal(reference.model.getText(), 'mine');
	browser.window.close();
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for file refresh');
}
