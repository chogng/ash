import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { createTestConfiguration } from './testConfiguration.js';

test('editor layout reserves height and emits layout changes', () => {
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using configuration = createTestConfiguration(container);
	let changes = 0;
	configuration.onDidChange(event => {
		if (event.hasChanged(EditorOption.layoutInfo)) changes++;
	});
	configuration.observeContainer({ width: 400, height: 300 });
	configuration.setReservedHeight(40);
	assert.equal(configuration.options.get(EditorOption.layoutInfo).height, 260);
	assert.equal(changes, 2);
	dom.window.close();
});
