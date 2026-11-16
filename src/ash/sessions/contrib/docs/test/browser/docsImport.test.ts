import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { zipFiles } from '../../../../../base/browser/zip.js';
import { URI } from '../../../../../base/common/uri.js';
import { importDocsHtml, importDocsText } from '../../browser/docsImportExport.js';
import { importDocsDocx } from '../../browser/docsDocxImport.js';

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function docx(body: string, parts: Record<string, string | Uint8Array> = {}): Uint8Array {
	return zipFiles(new Map(Object.entries({
		'_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
		'word/document.xml': `<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body>${body}</w:body></w:document>`, ...parts,
	}).map(([name, value]) => [name, typeof value === 'string' ? new TextEncoder().encode(value) : value])));
}
function rels(content: string): string { return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${content}</Relationships>`; }

test('Docs Markdown keeps source and code while embedding reference and repeated local images once', async () => {
	const source = '```md\n![A](diagram.png)\n```\n\n`![A](diagram.png)`\n\n> ![A](diagram.png)\n\n![A][picture]\n\n[picture]: diagram.png\n\nA\n\n![B](other.png)\n';
	const reads: string[] = [];
	const result = await importDocsText(source, 'markdown', URI.file('/notes/source.md'), async resource => { reads.push(resource.path); return new Uint8Array([0, 127, 255]); });
	assert.deepEqual(reads, ['/notes/diagram.png', '/notes/other.png']);
	assert.equal(result, source.replace('> ![A](diagram.png)', '> ![A](data:image/png;base64,AH//)').replace('![A][picture]', '![A](data:image/png;base64,AH//)').replace('![B](other.png)', '![B](data:image/png;base64,AH//)'));
});

test('Docs image edits preserve CRLFs and do not touch fenced code', async () => {
	const source = '```\r\n![A](local.png)\r\n```\r\n\r\n![A](local.png)\r\n';
	assert.equal(await importDocsText(source, 'markdown', URI.file('/source.md'), async () => new Uint8Array([0])), '```\r\n![A](local.png)\r\n```\r\n\r\n![A](data:image/png;base64,AA==)\r\n');
});

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

test('Docs DOCX imports numbered lists and embedded images without an extension model', async () => {
	const dom = new JSDOM();
	try {
		const body = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p>'
			+ '<w:p><w:r><w:drawing xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="image"/></w:drawing></w:r></w:p>';
		const bytes = docx(body, {
			'word/_rels/document.xml.rels': rels(`<Relationship Id="numbering" Type="${r}/numbering" Target="numbering.xml"/><Relationship Id="image" Type="${r}/image" Target="media/a.png"/>`),
			'word/media/a.png': new Uint8Array([0, 127, 255]),
			'word/numbering.xml': `<w:numbering xmlns:w="${w}"><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num></w:numbering>`,
		});
		assert.equal(await importDocsDocx(bytes, dom.window.document, new AbortController().signal), '3. First\n\n![](data:image/png;base64,AH//)');
	} finally { dom.window.close(); }
});

for (const body of ['<w:ins><w:r><w:t>Tracked edit</w:t></w:r></w:ins>', '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>', '<w:p><w:hyperlink r:id="bad"><w:r><w:t>Unsafe</w:t></w:r></w:hyperlink></w:p>']) test('Docs DOCX rejects unsupported structure or unsafe destinations without creating partial Markdown: ' + body.slice(0, 25), async () => {
	const dom = new JSDOM();
	try {
		await assert.rejects(importDocsDocx(docx(body, { 'word/_rels/document.xml.rels': rels(`<Relationship Id="bad" Type="${r}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>`) }), dom.window.document, new AbortController().signal));
	} finally { dom.window.close(); }
});
