import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { PdfPage } from '../../../../../platform/pdf/common/pdfService.js';
import { PdfPageView } from '../../browser/pdfPageView.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('PDF page eviction detaches the raster without resetting its source', async () => {
	const { window } = new JSDOM();
	window.HTMLImageElement.prototype.decode = async () => { };
	try {
		using view = new PdfPageView(window.document, {
			pointerDown() { }, pointerMove() { }, pointerUp() { }, pointerCancel() { },
		});
		const page: PdfPage = {
			page: 1, revision: 0, sha256: '', pageCount: 1, width: 1, height: 1, widthPoints: 1, heightPoints: 1,
			text: '', textTruncated: false, characters: [], annotations: [], annotationsTruncated: false,
			imageSize: 1, imageSha256: '', fileSize: 0,
		};
		window.document.body.append(view.domNode);
		await view.render(page, new Uint8Array([1]), 1600, undefined, true);
		const image = view.domNode.querySelector('img');
		assert.ok(image);
		const url = image.src;
		assert.ok(resolveObjectURL(url));

		view.domNode.remove();
		view.dispose();

		assert.equal(image.parentNode, null);
		assert.equal(image.getAttribute('src'), url);
		assert.equal(resolveObjectURL(url), undefined);
	} finally {
		window.close();
	}
});
