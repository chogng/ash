import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { JSDOM } from 'jsdom';
import { createZip } from '../../../../../base/common/zip.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { importDocsHtml, importDocsText, importDocsDocx } from '../../browser/docsImportExport.js';

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function docx(body: string, parts: Record<string, string | Uint8Array> = {}): Uint8Array {
	return createZip(Object.entries({
		'_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
		'word/document.xml': `<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body>${body}</w:body></w:document>`, ...parts,
	}).map(([path, value]) => ({ path, contents: typeof value === 'string' ? VSBuffer.fromString(value) : VSBuffer.wrap(new Uint8Array(value)) }))).buffer;
}
function rels(content: string): string { return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${content}</Relationships>`; }

test('Docs text import escapes Markdown and never reads image-looking text', async () => {
	const result = await importDocsText('# Heading\r\n![image](local.png)', 'text', URI.file('/notes/source.txt'), async () => assert.fail('plain text read an image'));
	assert.equal(result, '\\# Heading\n\\!\\[image\\]\\(local.png\\)');
});

test('Docs HTML uses its supplied document and preserves safe embedded images', () => {
	const dom = new JSDOM();
	try { assert.equal(importDocsHtml('<p>Body</p><img src="data:image/png;base64,AH//" alt=""><script>secret</script>', dom.window.document), 'Body\n\n![](data:image/png;base64,AH//)'); }
	finally { dom.window.close(); }
});

test('Docs DOCX imports standard OOXML and ignores extension-private snapshots', async () => {
	const dom = new JSDOM();
	try {
		const body = '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>'
			+ '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r></w:p>'
			+ '<w:p><w:hyperlink r:id="link"><w:r><w:t>Docs</w:t></w:r></w:hyperlink></w:p>'
			+ '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
		const bytes = docx(body, { 'customXml/ash-document.json': '{invalid legacy snapshot', 'word/_rels/document.xml.rels': rels(`<Relationship Id="link" Type="${r}/hyperlink" Target="https://example.com" TargetMode="External"/>`) });
		assert.equal(await importDocsDocx(bytes, dom.window.document, new AbortController().signal), '## Title\n\n**Bold**\n\n[Docs](https://example.com)\n\n| Cell |\n| --- |');
	} finally { dom.window.close(); }
});


for (const body of ['<w:ins><w:r><w:t>Tracked edit</w:t></w:r></w:ins>', '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>', '<w:p><w:hyperlink r:id="bad"><w:r><w:t>Unsafe</w:t></w:r></w:hyperlink></w:p>']) test('Docs DOCX rejects unsupported structure or unsafe destinations without creating partial Markdown: ' + body.slice(0, 25), async () => {
	const dom = new JSDOM();
	try {
		await assert.rejects(importDocsDocx(docx(body, { 'word/_rels/document.xml.rels': rels(`<Relationship Id="bad" Type="${r}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>`) }), dom.window.document, new AbortController().signal));
	} finally { dom.window.close(); }
});

suite('Docs image import through Arkdown', () => {
	const browser = useBrowserTests();
	const png = async () => {
		await browser.page.goto('/arkdown.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		return browser.page.evaluate(() => {
			const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
			const context = canvas.getContext('2d')!; context.fillStyle = 'green'; context.fillRect(0, 0, 2, 2);
			const source = canvas.toDataURL();
			return { source, bytes: Array.from(atob(source.split(',')[1]), character => character.charCodeAt(0)) };
		});
	};

	test('keeps code and source while embedding reference and repeated local images once', async () => {
		const image = await png();
		const source = '```md\n![A](diagram.png)\n```\n\n`![A](diagram.png)`\n\n> ![A](diagram.png)\n\n![A][picture]\n\n[picture]: diagram.png\n\nA\n\n![B](other.png)\n';
		const result = await browser.page.evaluate(({ source, bytes }) => window.arkdownFixture.importMarkdown(source, { 'file:///notes/diagram.png': bytes, 'file:///notes/other.png': bytes }), { source, bytes: image.bytes });
		assert.deepEqual(result.reads, ['file:///notes/diagram.png', 'file:///notes/other.png']);
		assert.equal(result.markdown, source.replace('> ![A](diagram.png)', `> ![A](<${image.source}>)`).replace('![A][picture]', `![A](<${image.source}>)`).replace('![B](other.png)', `![B](<${image.source}>)`));
	});

	test('keeps UTF-16 positions and CRLFs with fenced code inside a quoted list', async () => {
		const image = await png();
		const source = '中文🙂\r\n\r\n> - ```md\r\n>   ![A](local.png)\r\n>   ```\r\n> - ![A](local.png)\r\n';
		const result = await browser.page.evaluate(({ source, bytes }) => window.arkdownFixture.importMarkdown(source, { 'file:///notes/local.png': bytes }), { source, bytes: image.bytes });
		assert.deepEqual(result.reads, ['file:///notes/local.png']);
		assert.equal(result.markdown, source.replace('> - ![A](local.png)', `> - ![A](<${image.source}>)`));
	});

	test('uses the shared image writer to preserve layout metadata and decoded paths', async () => {
		const image = await png();
		const title = 'ash-image:' + JSON.stringify({ width: 120, alignment: 'center', title: 'Caption' });
		const source = `![A](<a%20b.png> '${title}')`;
		const result = await browser.page.evaluate(({ source, bytes }) => window.arkdownFixture.importMarkdown(source, { 'file:///notes/a%20b.png': bytes }), { source, bytes: image.bytes });
		assert.deepEqual(result.reads, ['file:///notes/a%20b.png']);
		assert.ok(result.markdown.includes(image.source));
		assert.ok(result.markdown.includes('ash-image:'));
		assert.ok(result.markdown.includes('120'));
		assert.ok(result.markdown.includes('center'));
		assert.ok(result.markdown.includes('Caption'));
	});

	test('rejects corrupt image bytes through the same boundary as pasted images', async () => {
		await png();
		await assert.rejects(browser.page.evaluate(() => window.arkdownFixture.importMarkdown('![Image](broken.png)', { 'file:///notes/broken.png': [0, 127, 255] })), /Choose a PNG, JPEG, GIF or WebP image/u);
	});

	test('Docs DOCX imports numbered lists and embedded images without an extension model', async () => {
		const image = await png();
		const body = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p>'
			+ '<w:p><w:r><w:drawing xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="image"/></w:drawing></w:r></w:p>';
		const bytes = docx(body, {
			'word/_rels/document.xml.rels': rels(`<Relationship Id="numbering" Type="${r}/numbering" Target="numbering.xml"/><Relationship Id="image" Type="${r}/image" Target="media/a.png"/>`),
			'word/media/a.png': new Uint8Array(image.bytes),
			'word/numbering.xml': `<w:numbering xmlns:w="${w}"><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num></w:numbering>`,
		});
		assert.equal(await browser.page.evaluate(bytes => window.arkdownFixture.importDocx(bytes), Array.from(bytes)), `3. First\n\n![](${image.source})`);
	});
});
