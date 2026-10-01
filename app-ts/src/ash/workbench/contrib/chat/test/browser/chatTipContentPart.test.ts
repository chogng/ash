import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ChatTipContentPart } from '../../browser/widget/chatContentParts/chatTipContentPart.js';

test('ChatTipContentPart creates its content in the host document and releases dismissal handling', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	try {
		const container = dom.window.document.querySelector('main')!;
		let dismissals = 0;
		using part = new ChatTipContentPart(container, { id: 'tip', content: new MarkdownString('A **helpful** tip') }, () => { dismissals++; });
		assert.equal(part.domNode.ownerDocument, container.ownerDocument);
		assert.equal(part.domNode.isConnected, false);
		container.append(part.domNode);
		assert.equal(part.domNode.querySelector('strong')?.textContent, 'helpful');
		const dismiss = part.domNode.querySelector('button')!;
		dismiss.click();
		assert.equal(dismissals, 1);
		part.dispose();
		dismiss.click();
		assert.deepEqual({ dismissals, mounted: container.children.length }, { dismissals: 1, mounted: 0 });
	} finally {
		dom.window.close();
	}
});
