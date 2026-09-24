import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { FormattingContribution } from '../../contrib/formatting/browser/formattingContribution.js';

test('Academic formatting contribution releases select listeners with its toolbar', () => {
	const environment = new JSDOM('<!doctype html><body></body>');
	const styles: unknown[] = [];
	const contribution = new FormattingContribution(environment.window.document.body, {
		documentActions: [],
		onToggleMark: () => undefined,
		onSetTextStyle: style => { styles.push(style); },
		onClearTextStyle: () => undefined,
		onRunDocumentAction: () => undefined,
	});
	try {
		contribution.setState({
			context: 'text',
			readOnly: false,
			bold: false,
			italic: false,
			fontFamily: undefined,
			fontSize: undefined,
			checkedDocumentActionIds: new Set(),
		});
		const select = contribution.element.querySelector<HTMLSelectElement>("select[aria-label='Font family']")!;
		select.value = 'serif';
		select.dispatchEvent(new environment.window.Event('change'));
		assert.deepEqual(styles, [{ fontFamily: 'serif' }]);

		contribution.dispose();
		select.value = 'monospace';
		select.dispatchEvent(new environment.window.Event('change'));
		assert.deepEqual(styles, [{ fontFamily: 'serif' }]);
		assert.equal(environment.window.document.querySelector('.stanza-structured-format-toolbar'), null);
	} finally {
		contribution.dispose();
		environment.window.close();
	}
});
