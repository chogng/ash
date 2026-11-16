import { getDocument as loadPdf } from 'pdfjs-dist/legacy/build/pdf.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { unzipFiles } from '../../../../../base/browser/zip.js';

suite('Docs file export', () => {
	const browser = useBrowserTests();
	const mount = async (source: string) => {
		await browser.page.goto('/arkdown.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await browser.page.evaluate(source => window.arkdownFixture.mount(source), source);
	};

	test('offers DOCX, PDF and Markdown in the same order and preserves exact Markdown source', async () => {
		const source = '# 中文🙂\r\n\r\nUnchanged **formatting**\r\n';
		await mount(source);
		assert.deepEqual((await browser.page.evaluate(() => window.arkdownFixture.exportFormats)).map(format => format.id), ['docx', 'pdf', 'markdown']);
		const exported = await browser.page.evaluate(() => window.arkdownFixture.exportFile('markdown'));
		assert.equal(new TextDecoder().decode(new Uint8Array(exported)), source);
		await browser.page.evaluate(() => window.arkdownFixture.external(''));
		const blank = await unzipFiles(new Uint8Array(await browser.page.evaluate(() => window.arkdownFixture.exportFile('docx'))), new AbortController().signal);
		assert.match(new TextDecoder().decode(blank.get('word/document.xml')), /<w:body><w:p\/>/u);
	});

	test('localizes the three export formats in Chinese', async () => {
		await browser.page.goto('/arkdown.html?locale=zh-CN');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		assert.deepEqual((await browser.page.evaluate(() => window.arkdownFixture.exportFormats)).map(format => format.label), ['Word 文档 (.docx)', 'PDF 文档 (.pdf)', 'Markdown 文件 (.md)']);
	});

	test('exports editable DOCX structure, Unicode, links, lists and tables from one captured version', async () => {
		await mount('# 中文🙂\n\n**Bold** and _italic_ with [Docs](https://example.com)\n\n3. First\n4. Second\n\n| Header |\n| --- |\n| Cell |');
		const bytes = new Uint8Array(await browser.page.evaluate(() => window.arkdownFixture.exportFile('docx', 'Changed while export loads')));
		const parts = await unzipFiles(bytes, new AbortController().signal);
		const xml = new TextDecoder().decode(parts.get('word/document.xml'));
		assert.match(xml, /中文🙂/u);
		assert.match(xml, /<w:pStyle w:val="Heading1"/u);
		assert.match(xml, /<w:b\//u);
		assert.match(xml, /<w:i\//u);
		assert.match(xml, /<w:tbl>/u);
		assert.match(xml, /<w:numPr>/u);
		assert.doesNotMatch(xml, /Changed while export loads/u);
		assert.match(new TextDecoder().decode(parts.get('word/_rels/document.xml.rels')), /https:\/\/example.com/u);
		assert.match(new TextDecoder().decode(parts.get('word/numbering.xml')), /w:start w:val="3"/u);
		assert.ok(!parts.has('customXml/ash-document.json'));
		writeFileSync(browser.info.outputPath('document.docx'), bytes);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'Changed while export loads');
	});

	test('exports decoded images into DOCX and does not include comment storage blocks', async () => {
		await mount('Document **selection**');
		await browser.page.getByRole('textbox', { name: 'Document body', exact: true }).locator('strong').evaluate(element => {
			const range = document.createRange(); range.selectNodeContents(element);
			const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		});
		await browser.page.evaluate(() => window.arkdownFixture.createComment('Private comment body', window.arkdownFixture.captureComment()));
		await browser.page.evaluate(() => {
			const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
			const context = canvas.getContext('2d')!; context.fillStyle = 'red'; context.fillRect(0, 0, 8, 8);
			window.arkdownFixture.external(window.arkdownFixture.source + `\n\n![Diagram](${canvas.toDataURL()})\n\n![WebP](${canvas.toDataURL('image/webp')})`);
		});
		const parts = await unzipFiles(new Uint8Array(await browser.page.evaluate(() => window.arkdownFixture.exportFile('docx'))), new AbortController().signal);
		const xml = new TextDecoder().decode(parts.get('word/document.xml'));
		assert.ok(parts.has('word/media/image1.png'));
		assert.ok(parts.has('word/media/image2.png'));
		assert.ok(!parts.has('word/media/image2.webp'));
		assert.match(xml, /<w:drawing>/u);
		assert.match(xml, /descr="Diagram"/u);
		assert.doesNotMatch(xml, /Private comment body|ash-comments/u);
	});

	test('exports nonblank paginated PDF pages and cleans up the offscreen snapshot', async () => {
		await mount('# PDF 中文🙂\n\n' + Array.from({ length: 80 }, (_, index) => `Paragraph ${index}: readable text with **formatting**.`).join('\n\n'));
		const bytes = new Uint8Array(await browser.page.evaluate(() => window.arkdownFixture.exportFile('pdf')));
		const text = new TextDecoder('latin1').decode(bytes);
		assert.ok(text.startsWith('%PDF-1.4'));
		assert.ok(Number(/\/Count (\d+)/.exec(text)![1]) > 1);
		assert.match(text, /startxref\n\d+\n%%EOF/u);
		const loading = loadPdf({ data: bytes.slice(), isImageDecoderSupported: false });
		try {
			const pdf = await loading.promise;
			assert.ok(pdf.numPages > 1);
			for (let index = 1; index <= pdf.numPages; index++) assert.ok((await (await pdf.getPage(index)).getOperatorList()).fnArray.length > 0);
		} finally { await loading.destroy(); }
		writeFileSync(browser.info.outputPath('document.pdf'), bytes);
		// Decode a stored JPEG page to ensure SVG capture produced ink, not a blank PDF.
		const start = bytes.findIndex((value, index) => value === 255 && bytes[index + 1] === 216);
		let end = start + 2; while (!(bytes[end] === 255 && bytes[end + 1] === 217) && end < bytes.length - 1) end++;
		assert.ok(start > 0 && end < bytes.length - 1);
		const darkPixels = await browser.page.evaluate(async values => {
			const image = await createImageBitmap(new Blob([new Uint8Array(values)], { type: 'image/jpeg' }));
			const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
			const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); image.close();
			const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
			let count = 0; for (let index = 0; index < data.length; index += 4) if (data[index] < 100) count++;
			return count;
		}, Array.from(bytes.slice(start, end + 2)));
		assert.ok(darkPixels > 1000, `PDF page only had ${darkPixels} dark pixels`);
		assert.equal(await browser.page.locator('section[aria-hidden="true"][inert]').count(), 0);
	});

	test('rejects aborted exports without starting output work', async () => {
		await mount('Source');
		for (const format of ['docx', 'pdf', 'markdown']) assert.equal(await browser.page.evaluate(format => window.arkdownFixture.abortedExport(format), format), true);
	});
});
