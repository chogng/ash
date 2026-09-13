import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Minimap } from '../../browser/viewParts/minimap/minimap.js';
import { PartFingerprint, PartFingerprints } from '../../browser/view/viewPart.js';
import { TextModel } from '../../common/model/textModel.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';

test('Minimap owns one canvas and removes its DOM node on disposal', () => {
	const dom = new JSDOM('<div id="editor"></div>');
	const host = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using model = new TextModel('one\ntwo');
	const minimap = new Minimap(testViewContext(), {
		host,
		model,
		options: { enabled: true } as never,
		tabSize: 4,
		paddingTop: 0,
		paddingBottom: 0,
		readLayout: () => { throw new Error('not rendered'); },
		readMinimapLayout: () => { throw new Error('not rendered'); },
		readVisualProjection: () => { throw new Error('not rendered'); },
		readProjectionRevision: () => 0,
		scrollTo: () => { },
	});
	assert.equal(host.querySelectorAll('canvas').length, 1);
	const root = minimap.getDomNode();
	assert.strictEqual(minimap.getDomNode(), root);
	assert.equal(PartFingerprints.read(root.domNode), PartFingerprint.Minimap);
	minimap.dispose();
	assert.equal(host.children.length, 0);
	dom.window.close();
});

function testViewContext(): ViewContext {
	return { addEventHandler() {}, removeEventHandler() {} } as unknown as ViewContext;
}
