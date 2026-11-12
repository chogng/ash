import '../../../../../editor/test/browser/testEditorDom.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IExtensionHostApi } from '../../../../../platform/extensions/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../../../platform/extensions/browser/extensionHostApi.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ChatContentMarkdownRenderer } from '../../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { chatMarkdownRichContentExtension, renderChatRichContentText } from '../../../../../workbench/contrib/chat/browser/widget/chatMarkdownRichContent.js';
import { decodeChatGPTReply } from '../../browser/chatGPTRichContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatGPTClient, type ChatGPTReference } from '../../browser/chatGPTClient.js';

function render(value: string, references?: readonly ChatGPTReference[]): string {
	using services = new InstantiationService(new ServiceCollection([IOpenerService, { open: async () => true } as unknown as IOpenerService]));
	services.registerInstance(IExtensionHostApi, createDisconnectedExtensionHostApi(async () => { throw new Error('No extension host'); }));
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IMarkdownRendererService, services.createInstance(MarkdownRendererService));
	using resultRenderer = services.createInstance(ChatContentMarkdownRenderer);
	const reply = decodeChatGPTReply(value, references, 'fixture');
	using result = resultRenderer.render({ value: reply.text, supportHtml: true, supportThemeIcons: true, isTrusted: false }, {
		markedExtensions: reply.richContent && [chatMarkdownRichContentExtension(reply.richContent)],
	});
	return result.element.innerHTML;
}

function getChatGPTRichContentText(source: string, references?: readonly ChatGPTReference[]): string {
	const reply = decodeChatGPTReply(source, references);
	return renderChatRichContentText(reply.text, reply.richContent);
}

suite('ChatGPT rich content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('renders writing bodies as shared Markdown without displaying envelope metadata', () => {
		const source = 'Before\n\n:::writing{variant="chat_message" id="64821" title="A } quoted title"}**杭州周末**\n\n两间房共1160元。:::\n\nAfter';
		assert.equal(decodeChatGPTReply(source).richContent?.parts.find(part => part.kind === 'writing')?.title, 'A } quoted title');
		const html = render(source);
		assert.match(html, /Before[\s\S]*<strong>杭州周末<\/strong>[\s\S]*两间房共1160元。[\s\S]*After/u);
		assert.doesNotMatch(html, /:::|variant=|64821|quoted title/u);
		const text = getChatGPTRichContentText(source);
		assert.match(text, /Before[\s\S]*杭州周末[\s\S]*1160[\s\S]*After/u);
		assert.doesNotMatch(text, /:::|variant=|64821/u);
		assert.doesNotMatch(text, /Edit in Docs/u);
	});

	test('keeps writing text while streaming and preserves writing examples inside code', () => {
		assert.match(render(':::writing{variant="chat_message"}**Visible draft**'), /<strong>Visible draft<\/strong>/u);
		assert.ok(!decodeChatGPTReply(':::writing{variant="chat_message"}**Visible draft**').richContent?.parts.some(part => part.kind === 'writing'));
		assert.match(render(':::writing{title="Indented example"}\n    echo ready\n:::'), /<pre[\s\S]*<code>echo ready/u);
		assert.doesNotMatch(render('Before\n\n:::writing{variant="chat_message'), /:::|variant=/u);
		const source = '`:::writing{id="inline"}literal:::`\n\n```text\n:::writing{id="fenced"}example:::\n```';
		const root = document.createElement('div'); root.innerHTML = render(source);
		assert.deepEqual([...root.querySelectorAll('code')].map(element => element.textContent?.trim()), [':::writing{id="inline"}literal:::', ':::writing{id="fenced"}example:::']);
	});
	test('keeps the shared formula grammar when rich content extensions are installed', () => {
		const cases = JSON.parse(readFileSync('test/fixtures/markdownMath.json', 'utf8')) as { name: string; markdown: string; formulas: { source: string; display: string; }[]; }[];
		const combined = cases.filter(entry => entry.formulas.length || ['code and escapes', 'currency and jQuery'].includes(entry.name));
		cases.push({ name: 'combined compatibility document', markdown: combined.map(entry => entry.markdown).join('\n\n'), formulas: combined.flatMap(entry => entry.formulas) });
		for (const entry of cases) {
			const root = document.createElement('div'); root.innerHTML = render(entry.markdown);
			assert.deepEqual([...root.querySelectorAll<HTMLElement>('.ash-katex-container')].map(element => ({ source: element.dataset.latex, display: element.dataset.mathDisplay })), entry.formulas, entry.name);
		}
	});

	test('resolves web reference encodings into source cards and links while keeping code literal', () => {
		const references = [{ id: 'turn2search1', title: 'CSV documentation', url: 'https://docs.python.org/3/library/csv.html', snippet: 'Read and write tabular data.' }];
		const source = 'A <Cite refs={[["turn2search1"]]}/> B urlPython docsturn2search1 C citeturn2search1\n\n`citeturn2search1`';
		const root = document.createElement('div'); root.innerHTML = render(source, references);
		assert.equal(root.querySelectorAll('.ash-chat-citation').length, 2);
		const citation = root.querySelector('.ash-chat-citation')!;
		assert.equal(citation.querySelector('.ash-chat-citation-label')?.textContent, '1 source');
		assert.equal(citation.querySelector('.ash-chat-citation-title')?.textContent, 'CSV documentation');
		assert.equal(citation.querySelector('.ash-chat-citation-domain')?.textContent, 'docs.python.org');
		assert.equal(citation.querySelector('a')?.href, references[0]!.url);
		assert.equal(citation.querySelector('a')?.title, 'CSV documentation\nRead and write tabular data.');
		const annotatedLink = [...root.querySelectorAll('a')].find(link => link.textContent === 'Python docs');
		assert.equal(annotatedLink?.href, references[0]!.url);
		assert.equal(annotatedLink?.title, 'CSV documentation\nRead and write tabular data.');
		assert.equal(root.querySelector('code')?.textContent, 'citeturn2search1');
		assert.equal((root.textContent?.match(/cite/gu) ?? []).length, 1);
		assert.match(getChatGPTRichContentText(source, references), /CSV documentation[\s\S]*Read and write tabular data/u);
		const attributed = { id: 'turn2search2', title: 'Additional source', url: 'https://example.test/attributed', snippet: '', cited: true } as const;
		const unused = { id: 'turn2search3', title: 'Unused search result', url: 'https://example.test/unused', snippet: '' };
		assert.deepEqual(decodeChatGPTReply(source, [...references, attributed, unused]).citations, [
			{ type: 'web', url: attributed.url, title: attributed.title },
			{ type: 'web', url: references[0]!.url, title: references[0]!.title },
		]);
	});

	test('decodes direct web links, citations and entity labels inside Markdown containers', () => {
		const link = '\uE200url\uE202Example / Repo\uE202https://example.test/repo?a=1&b=2\uE201';
		const citation = '\uE200cite\uE202turn2search1\uE201';
		const entity = '\uE200entity\uE202["software","GPUI Kit","UI library"]\uE201';
		const invalid = '\uE200url\uE202Blocked link\uE202javascript:alert(1)\uE201';
		const source = [
			'1. ' + link + '：使用 Rust。',
			'   另见 ' + citation,
			'   - ' + entity,
			'   - ' + invalid,
			'   - `' + link + '`',
			'',
			'> 另一个示例',
			'> ' + entity,
			'',
			'| Name |',
			'| --- |',
			'| ' + entity + ' |',
		].join('\n');
		const references = [{ id: 'turn2search1', title: 'Source', url: 'https://example.test/source', snippet: 'Details' }];
		const root = document.createElement('div');
		root.innerHTML = render(source, references);
		assert.equal(root.querySelector('ol > li > a')?.getAttribute('href'), 'https://example.test/repo?a=1&b=2');
		assert.equal(root.querySelector('ol > li > a')?.textContent, 'Example / Repo');
		assert.equal(root.querySelector('ol > li > a')?.getAttribute('title'), null);
		assert.match(root.querySelector('ol > li')?.textContent ?? '', /Repo：使用 Rust。/u);
		assert.equal(root.querySelector('ol .ash-chat-citation .ash-chat-citation-title')?.textContent, 'Source');
		assert.deepEqual([...root.querySelectorAll('ol ul > li')].map(item => item.textContent), ['GPUI Kit', 'Blocked link', link]);
		assert.equal(root.querySelector('code')?.textContent, link);
		assert.match(root.querySelector('blockquote')?.textContent ?? '', /GPUI Kit/u);
		assert.equal(root.querySelector('td')?.textContent, 'GPUI Kit');
		root.querySelector('code')?.remove();
		assert.doesNotMatch(root.textContent ?? '', /[\uE200-\uE202]|UI library/u);
		assert.match(getChatGPTRichContentText(source, references), /使用 Rust。[\s\S]*Source[\s\S]*GPUI Kit/u);
	});

	test('attaches standalone source markers to the preceding paragraph', () => {
		const root = document.createElement('div');
		const references = [{ id: 'turn0search1', title: 'Source', url: 'https://example.com/', snippet: 'Details' }];
		root.innerHTML = render('Floem paragraph.\n\n<Cite refs={[["turn0search1"]]}/>\n\n<Link url="https://example.com/" title="Floem source"/>', references);
		assert.equal(root.querySelector('p > .ash-chat-citation .ash-chat-citation-label')?.textContent, '1 source');
		assert.equal(root.querySelector('p > .ash-chat-external-link'), null);
	});

	test('renders saved web link actions and subtle dividers within rich reply layouts', () => {
		const source = [
			'<row><box>',
			'  <Link url="https://github.com/lapce/floem" title="Floem 源码"/>',
			'</box></row>',
			'<divider color="subtle"/>',
			'<row><box>',
			'  <Link url="https://slint.dev" title="Slint 官网"/>',
			'</box></row>',
			'<Link url="javascript:alert(1)" title="Unsafe action"/>',
			'<Link url="https://user:pass@example.com/" title="Credentialed URL"/>',
		].join('\n');
		const root = document.createElement('div');
		root.innerHTML = render(source);
		const divider = root.querySelector('hr')!;
		assert.equal(divider.previousElementSibling?.textContent?.trim(), 'Floem 源码');
		assert.equal(divider.nextElementSibling?.textContent?.trim(), 'Slint 官网');
		assert.deepEqual([...root.querySelectorAll('a')].map(anchor => [
			anchor.textContent, anchor.href, anchor.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'),
		]), [
			['Floem 源码', 'https://github.com/lapce/floem', 'link-external'],
			['Slint 官网', 'https://slint.dev/', 'link-external'],
		]);
		assert.equal(root.querySelector('details, pre'), null);
		assert.match(root.textContent ?? '', /Unsafe action[\s\S]*Credentialed URL/u);
		assert.match(getChatGPTRichContentText(source), /Floem 源码[\s\S]*Slint 官网/u);
	});

	test('keeps Markdown and nested component text in their original order', () => {
		const source = 'Before\n\n<box gap={2}><box>**First**</box><row><icon name="arrow-down"/></row><text>Second</text></box>\n\nAfter';
		const html = render(source);
		assert.match(html, /Before[\s\S]*<strong>First<\/strong>[\s\S]*↓[\s\S]*Second[\s\S]*After/u);
		assert.doesNotMatch(html, /<\/?(?:box|row|text|icon)\b/u);
		assert.match(getChatGPTRichContentText(source), /Before[\s\S]*First[\s\S]*↓[\s\S]*Second[\s\S]*After/u);
		assert.doesNotMatch(getChatGPTRichContentText(source), /\*\*|<box>/u);
	});

	test('renders reply grids and captions without exposing their layout properties', () => {
		const source = `<box>
  **Architecture**
  <caption>Application and window</caption>
  <grid columns={2} gap={2}>
    <grid-item><box>**Native UI**</box></grid-item>
    <grid-item><box>**Web engine**</box></grid-item>
  </grid>
  <caption textAlign="center">Concept diagram</caption>
</box>

<table><caption>Table caption</caption><tr><td>Cell</td></tr></table>`;
		const root = document.createElement('div');
		root.innerHTML = render(source);
		const grid = root.querySelector('.ash-chat-rich-grid.columns-2.gap-2');
		assert.deepEqual([...grid?.children ?? []].map(cell => cell.textContent?.trim()), ['Native UI', 'Web engine']);
		assert.deepEqual([...root.querySelectorAll('.ash-chat-rich-text.color-secondary')].map(caption => caption.textContent?.trim()), ['Application and window', 'Concept diagram']);
		assert.equal(root.querySelector('.ash-chat-rich-text.align-center')?.textContent?.trim(), 'Concept diagram');
		assert.equal(root.querySelector('table > caption')?.textContent, 'Table caption');
		assert.equal(root.querySelector('details, pre'), null);
		const accessibleText = getChatGPTRichContentText(source);
		assert.match(accessibleText, /Architecture[\s\S]*Application and window[\s\S]*Native UI[\s\S]*Web engine[\s\S]*Concept diagram/u);
		assert.doesNotMatch(accessibleText, /columns|gap|Content/u);
	});

	test('keeps grid content readable when the reply has invalid or unfinished layout data', () => {
		const root = document.createElement('div');
		root.innerHTML = render('<grid columns={globalThis.auditXss = true} gap={99}><grid-item>First</grid-item></grid>');
		assert.equal(root.querySelector('.ash-chat-rich-grid.columns-1')?.textContent?.trim(), 'First');
		assert.doesNotMatch(root.innerHTML, /auditXss|gap-99/u);
		assert.match(render('<grid columns={2}>\n<grid-item>First card</grid-item>\n\nSecond card'), /First card[\s\S]*Second card/u);
	});

	test('hides image search metadata in complete and streaming replies while preserving literal code', () => {
		const marker = '\uE200image_group\uE202{"layout":"carousel","query":["public project"]}\uE201';
		assert.match(render(`${marker}\n\n**Project summary**`), /<strong>Project summary<\/strong>/u);
		assert.doesNotMatch(render(`${marker}\n\nProject summary`), /image_group|public project/u);
		assert.doesNotMatch(getChatGPTRichContentText(`Project summary ${marker.slice(0, -3)}`), /image_group|public project/u);
		assert.match(render('`' + marker + '`'), /<code>.*image_group/u);
		const image = { uri: 'https://images.openai.com/static-rsc-4/fixture-image', label: 'Project screenshot', source: 'https://example.test/project' };
		const reply = decodeChatGPTReply(`Before\n\n${marker}\n\nAfter`, [], 'fixture', [{ marker, images: [image] }]);
		assert.deepEqual(reply.richContent?.parts, [{ kind: 'imageGallery', images: [image], block: true }]);
		assert.match(renderChatRichContentText(reply.text, reply.richContent), /Before[\s\S]*Image gallery[\s\S]*Project screenshot[\s\S]*After/u);
		assert.doesNotMatch(reply.text, /image_group|public project/u);
		const query = 'public project';
		const inline = decodeChatGPTReply(`<row><AsyncImage query="${query}"/>\n\n**Project summary**</row>`, [], 'fixture', [{ query, images: [image] }]);
		assert.ok(inline.richContent?.parts.some(part => part.kind === 'imageGallery' && part.compact));
		assert.match(renderChatRichContentText(inline.text, inline.richContent), /Project screenshot[\s\S]*Project summary/u);
	});

	test('renders entity thumbnail metadata as readable text without exposing the provider payload', () => {
		const marker = '\uE200genui\uE202' + JSON.stringify({
			entity_thumbnail_list: {
				entities: [{ name: 'Zed', desc: 'An editor using <GPUI>.', thumbnail_query: 'private query' }],
			}
		}) + '\uE201';
		const reply = decodeChatGPTReply(`Related projects\n\n${marker}\n\nAfter`);
		const text = renderChatRichContentText(reply.text, reply.richContent);
		assert.match(text, /Related projects[\s\S]*Zed[\s\S]*An editor using <GPUI>\.[\s\S]*After/u);
		assert.doesNotMatch(text, /genui|entity_thumbnail_list|private query/u);
		assert.doesNotMatch(render(`Related projects ${marker.slice(0, -4)}`), /genui|entity_thumbnail_list/u);
	});

	test('renders GenUI citation markers as inline sources in saved replies', () => {
		const references = [
			{ id: 'turn2search1', title: 'First paper', url: 'https://example.test/first', snippet: 'First abstract' },
			{ id: 'turn2search2', title: 'Second paper', url: 'https://example.test/second', snippet: 'Second abstract' },
		];
		const single = '\uE200genui\uE202{"citation":{"ref":"turn2search1"}}\uE201';
		const multiple = '\uE200genui\uE202{"citation":{"refs":["turn2search2","turn2search1","turn2search2",42,"turn2search3"]}}\uE201';
		const missing = '\uE200genui\uE202{"citation":{"ref":"turn2search3"}}\uE201';
		const source = `**First claim.** ${single}\n\nSecond claim. ${multiple}\n\nMissing source. ${missing}`;
		const root = document.createElement('div');
		root.innerHTML = render(source, references);
		const paragraphs = [...root.querySelectorAll('p')];
		assert.deepEqual(paragraphs.map(paragraph => [...paragraph.querySelectorAll('a')].map(link => link.href)), [
			[references[0]!.url], [references[1]!.url, references[0]!.url], [],
		]);
		assert.equal(paragraphs[0]?.querySelector('strong')?.textContent, 'First claim.');
		assert.doesNotMatch(root.textContent ?? '', /Media content|View this content|genui/u);
		assert.match(getChatGPTRichContentText(source, references), /Second claim\.[\s\S]*Second paper[\s\S]*Second abstract/u);
		assert.deepEqual(decodeChatGPTReply(source, references).citations, references.map(({ url, title }) => ({ type: 'web', url, title })));
	});

	test('removes only ChatGPT attribution from rich source links', () => {
		const url = 'https://example.test/paper?query=a%20b&utm_source=chatgpt.com&lang=en&utm_source=publisher&path=%2f#methods';
		const clean = 'https://example.test/paper?query=a%20b&lang=en&utm_source=publisher&path=%2f#methods';
		const references = [
			{ id: 'turn2search1', title: 'Paper', url, snippet: '', cited: true as const },
			{ id: 'turn2search2', title: 'Same paper', url: clean, snippet: '', cited: true as const },
		];
		const source = [
			'Paper. \uE200genui\uE202{"citation":{"ref":"turn2search1"}}\uE201',
			'\uE200url\uE202Paper link\uE202turn2search1\uE201',
			'\uE200url\uE202Direct link\uE202https://example.test/abstract?utm_source=chatgpt.com#results\uE201',
			'<Link url="https://example.test/other?utm_source=chatgpt.com&download=1" title="Other link"/>',
		].join('\n\n');
		const root = document.createElement('div');
		root.innerHTML = render(source, references);
		assert.deepEqual([...root.querySelectorAll('a')].map(link => link.getAttribute('href')), [
			clean, clean, 'https://example.test/abstract#results', 'https://example.test/other?download=1',
		]);
		assert.deepEqual(decodeChatGPTReply(source, references).citations, [
			{ type: 'web', url: clean, title: 'Paper' },
			{ type: 'web', url: 'https://example.test/abstract#results', title: 'Direct link' },
		]);
	});

	test('cleans ordinary Markdown links and preserves link labels, titles and code', () => {
		const tracked = 'https://example.test/paper?q=a%20b&utm_source=chatgpt.com&utm_source=publisher#methods';
		const clean = 'https://example.test/paper?q=a%20b&utm_source=publisher#methods';
		const source = [
			`[**Paper** \\[PDF\\]](${tracked} "Publication")`,
			'[Reference *label*][paper]',
			`<${tracked}>`,
			`\`${tracked}\``,
			'```text\n' + tracked + '\n```',
			`[paper]: ${tracked} "Referenced publication"`,
		].join('\n\n');
		const root = document.createElement('div');
		root.innerHTML = render(source);
		const links = [...root.querySelectorAll('a')];
		assert.deepEqual(links.map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('title')]), [
			['Paper [PDF]', clean, 'Publication'], ['Reference label', clean, 'Referenced publication'], [clean, clean, null],
		]);
		assert.equal(links[0]?.querySelector('strong')?.textContent, 'Paper');
		assert.equal(links[1]?.querySelector('em')?.textContent, 'label');
		assert.deepEqual([...root.querySelectorAll('code')].map(code => code.textContent?.trim()), [tracked, tracked]);
	});

	test('cleans bare URLs and formatted links inside Markdown tables and blockquotes', () => {
		const root = document.createElement('div');
		root.innerHTML = render('https://example.test/brief?utm_source=chatgpt.com#abstract.');
		assert.equal(root.querySelector('a')?.getAttribute('href'), 'https://example.test/brief#abstract');
		assert.equal(root.querySelector('p')?.textContent, 'https://example.test/brief#abstract.');
		root.innerHTML = render([
			'| Sources |', '| --- |',
			'| [A \\| **B**](<https://example.test/paper?q=a\\|b&amp;utm_source=chatgpt.com&amp;page=2#fig> "A \\| B") |',
			'',
			'> [Multi-line', '> **label**](https://example.test/brief?utm_source=chatgpt.com#abstract)',
		].join('\n'));
		const cellLink = root.querySelector('td a');
		assert.equal(cellLink?.textContent, 'A | B');
		assert.equal(cellLink?.getAttribute('href'), 'https://example.test/paper?q=a%7Cb&page=2#fig');
		assert.equal(cellLink?.getAttribute('title'), 'A | B');
		assert.equal(root.querySelector('blockquote a')?.getAttribute('href'), 'https://example.test/brief#abstract');
		assert.equal(root.querySelector('blockquote a strong')?.textContent, 'label');
	});

	test('leaves inline and fenced code examples literal', () => {
		const source = '`<box>inline</box>`\n\n```html\n<box>fenced</box>\n```';
		const html = render(source);
		assert.match(html, /<code>&lt;box&gt;inline&lt;\/box&gt;<\/code>/u);
		assert.match(html, /&lt;box&gt;fenced&lt;\/box&gt;/u);
		assert.doesNotMatch(html, /ash-chat-rich/u);
		assert.match(getChatGPTRichContentText(source), /<box>inline<\/box>[\s\S]*<box>fenced<\/box>/u);
		const nested = render('<box>\n  ```python\n  if ready:\n      run()\n  ```\n</box>');
		assert.match(nested, /if ready:\n {4}run\(\)/u);
	});

	test('maps ChatGPT icons to registered Ash glyphs and retains accessible text', () => {
		const names = ['check', 'x', 'arrow-down', 'arrow-up', 'arrow-left', 'arrow-right', 'arrow-down-up', 'plus', 'minus', 'info', 'warning', 'file'];
		const markers = [
			...names.map(name => `<icon name="${name}"/>`),
			'<icon name="pencil-line" size="lg"/>',
			'<icon name="lock-keyhole" size="lg"/>',
			'<icon name="key-round" label="Key"/>',
		];
		const iconIds = ['check', 'close', 'arrow-down', 'arrow-up', 'arrow-left', 'arrow-right', 'sort', 'add', 'remove', 'info', 'warning', 'file', 'edit', 'lock'];
		const parts = decodeChatGPTReply(markers.join(' ')).richContent!.parts;
		assert.deepEqual(parts.map(part => part.kind === 'icon' && part.icon?.id), [...iconIds, undefined]);
		const root = document.createElement('div');
		root.innerHTML = render(markers.join(' '));
		assert.deepEqual(Array.from(root.querySelectorAll<HTMLElement>('[data-ash-icon-id]'), icon => icon.dataset.ashIconId), iconIds);
		assert.equal(root.querySelector('.ash-chat-rich-icon:last-child')?.textContent, 'Key');
		assert.deepEqual(markers.map(marker => getChatGPTRichContentText(marker).trim()), ['✓', '×', '↓', '↑', '←', '→', '⇅', '+', '−', 'ⓘ', '⚠', 'file', '✎', '🔒', 'Key']);
	});

	test('resolves Web icon families through their canonical names and preserves unknown labels', () => {
		const icons = [
			['message-circle', 'chat'],
			['message-square', 'chat'],
			['chat', 'chat'],
			['paintbrush-vertical', 'paintbrush'],
			['cleanup', 'paintbrush'],
			['chart-spline', 'chart'],
			['chart-column', 'chart'],
			['zap', 'lightning'],
			['gauge-circle', 'dashboard'],
			['Grid2X2', 'layout-grid'],
			['layout', 'table'],
			['LogOut', 'sign-out'],
			['lucide:mic-vocal', 'mic'],
			['table-2', 'table'],
			['write-alt', 'edit'],
			['panel-left-close', 'layout-sidebar-left-off'],
			['circle-x', 'error'],
			['files', 'copy'],
		];
		const source = icons.map(([name]) => `<icon name="${name}" size="lg"/>`).join(' ')
			+ ' <icon name="landmark" label="Institution"/> <icon name="constructor"/>';
		const root = document.createElement('div');
		root.innerHTML = render(source);
		assert.deepEqual([...root.querySelectorAll<HTMLElement>('[data-ash-icon-id]')].map(element => element.dataset.ashIconId), icons.map(([, id]) => id));
		assert.match(getChatGPTRichContentText(source), /Institution\s+constructor/u);
	});

	test('does not evaluate JSX expressions, forward event handlers or render arbitrary HTML', () => {
		const html = render('<box padding={globalThis.auditXss = true} onclick="globalThis.auditXss = true" background="url(https://invalid.test/pixel)"><text>Visible</text><script>globalThis.auditXss = true</script></box>');
		assert.match(html, /Visible/u);
		assert.doesNotMatch(html, /onclick|auditXss|invalid\.test|<script/u);
		assert.equal(Reflect.get(globalThis, 'auditXss'), undefined);
	});

	test('matches nested components with quoted angle brackets and JSX border data', () => {
		const html = render('<box border={{size:1,color:"rgba(26,127,83,0.35)"}} title="a > b"><box><text>Content</text></box></box>\n\nTail');
		assert.match(html, /Content/u);
		assert.match(html, /border-rgba-26-127-83-0p35/u);
		assert.match(html, /<p>Tail<\/p>/u);
		assert.doesNotMatch(html, /title=/u);
	});

	test('retains unknown cards as disclosures and charts as isolated interactive resources', () => {
		const source = '<FuturePanel title="Panel title"><FutureCard>**Card body**</FutureCard></FuturePanel>\n\n<Chart title="Sales" data={[{"month":"May","amount":42}]}/>\n\nTail';
		const html = render(source);
		const root = document.createElement('div'); root.innerHTML = html;
		assert.match(root.textContent ?? '', /Panel title[\s\S]*Card body[\s\S]*Sales[\s\S]*Tail/u);
		const chart = decodeChatGPTReply(source).resources[0]!;
		assert.equal(chart.kind, 'chart');
		assert.deepEqual(JSON.parse(decodeURIComponent(chart.uri.slice(chart.uri.indexOf(',') + 1))), [{ month: 'May', amount: 42 }]);
		assert.equal(root.querySelectorAll('details').length, 2);
		assert.doesNotMatch(html, /ash-chat-rich-fallback/u);
		assert.doesNotMatch(html, /<\/?(?:FuturePanel|FutureCard|Chart)\b/u);
		assert.match(getChatGPTRichContentText(source), /Card body[\s\S]*Sales[\s\S]*May[\s\S]*42/u);
	});

	test('retains unfamiliar card properties and chart schemas without evaluating expressions', () => {
		const root = document.createElement('div');
		const source = '<FutureCard value={42} description="Score"/>\n\n<Chart data={missingValues()}/>\n\n<Chart title="Unknown schema" data={{"points":{"May":42},"caption":"Retained caption"}}/>';
		root.innerHTML = render(source);
		assert.match(root.textContent ?? '', /Score[\s\S]*42[\s\S]*missingValues\(\)/u);
		const chart = decodeChatGPTReply(source).resources[0]!;
		assert.deepEqual(JSON.parse(decodeURIComponent(chart.uri.slice(chart.uri.indexOf(',') + 1))), { points: { May: 42 }, caption: 'Retained caption' });
	});

	test('keeps semantic tables, disclosure text, subscript, superscript and Markdown formulas', () => {
		const html = render('<details><summary>Details title</summary><table><tr><th>Name</th><td>Value</td></tr></table>H<sub>2</sub>O and x<sup>2</sup></details>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$$x^2 + y^2 = z^2$$');
		assert.match(html, /<details><summary>Details title<\/summary>[\s\S]*<table>(?:<tbody>)?<tr><th>Name<\/th><td>Value<\/td><\/tr>(?:<\/tbody>)?<\/table>/u);
		assert.match(html, /H<sub>2<\/sub>O and x<sup>2<\/sup>/u);
		assert.match(html, /<td>1<\/td>[\s\S]*<td>2<\/td>/u);
		assert.match(html, /data-latex="x\^2 \+ y\^2 = z\^2"/u);
	});

	test('renders Entity labels as literal text in Markdown table cells and accessible text', () => {
		const source = [
			'| Framework | Notes |',
			'| --- | --- |',
			'| <Entity category="software" value="GPUI" disambig="Zed Rust GPU UI framework"/> | Native GPU toolkit |',
			String.raw`| Zed \| Rust <Entity data={{"category":"software","value":"GPUI","disambig":"Zed \| Rust"}}/> | Original row |`,
			String.raw`| <Entity data={{"value":"界面 \| <em>Kit</em> *UI*"}}/> | Second row |`,
		].join('\n');
		const root = document.createElement('div');
		root.innerHTML = render(source);
		const rows = [...root.querySelectorAll<HTMLTableRowElement>('tbody tr')];
		assert.deepEqual(rows.map(row => [...row.cells].map(cell => cell.textContent)), [
			['GPUI', 'Native GPU toolkit'],
			['Zed | Rust GPUI', 'Original row'],
			['界面 | <em>Kit</em> *UI*', 'Second row'],
		]);
		assert.equal(root.querySelector('td :is(details, pre, em)'), null);
		const accessibleText = getChatGPTRichContentText(source);
		assert.match(accessibleText, /Zed \| Rust GPUI[\s\S]*界面 \| <em>Kit<\/em> \*UI\*/u);
		assert.doesNotMatch(accessibleText, /category|disambig/u);
	});

	test('projects Web SVG diagrams in place as static images with accessible labels', async () => {
		const svg = [
			'<svg viewBox="0 0 110 112" width="100%" onload="alert(1)">',
			'  <rect x="5" y="13" width="100" height="34" rx="5" fill="#D9B8E8"/>',
			'  <text x="55" y="35" fontSize="13" textAnchor="middle" fontWeight="600">插层</text>',
			'  <path d="M55 48 V60" stroke="currentColor" strokeDasharray="2 2"/>',
			'  <circle cx="20" cy="60" r="4" fill="url(https://invalid.test/paint.svg#color)"/>',
			'  <script>alert(1)</script><foreignObject><iframe src="https://invalid.test/frame"/></foreignObject>',
			'  <image href="https://invalid.test/image.svg"/><animate attributeName="x" to="3"/>',
			'</svg>',
		].join('\n');
		const source = '<grid columns={3}><grid-item><box>\n' + svg + '\n</box></grid-item></grid>\n\nCaption';
		const reply = decodeChatGPTReply(source);
		const galleries = reply.richContent?.parts.filter(part => part.kind === 'imageGallery') ?? [];
		assert.equal(galleries.length, 1);
		assert.equal(galleries[0]?.images[0]?.label, '插层');
		assert.deepEqual(reply.resources, []);

		const root = document.createElement('div');
		root.innerHTML = render(source);
		assert.ok(root.querySelector('.ash-chat-rich-grid-item > .ash-chat-rich-box > .ash-chat-image-gallery'));
		assert.match(root.textContent ?? '', /Caption/u);
		assert.match(getChatGPTRichContentText(source), /插层[\s\S]*Caption/u);
		assert.doesNotMatch(root.innerHTML, /<svg|<rect|invalid\.test/u);

		const image = await new ChatGPTClient().readResource(URI.parse(galleries[0]!.images[0]!.uri).toString(), undefined, '', new AbortController().signal);
		assert.match(image.type, /^image\/svg\+xml\b/u);
		const imageDocument = new document.defaultView!.DOMParser().parseFromString(await image.text(), 'image/svg+xml');
		assert.equal(imageDocument.documentElement.namespaceURI, 'http://www.w3.org/2000/svg');
		assert.equal(imageDocument.documentElement.getAttribute('viewBox'), '0 0 110 112');
		assert.equal(imageDocument.querySelector('rect')?.getAttribute('fill'), '#D9B8E8');
		const label = imageDocument.querySelector('text');
		assert.equal(label?.getAttribute('x'), '55');
		assert.equal(label?.getAttribute('y'), '35');
		assert.equal(label?.getAttribute('font-size'), '13');
		assert.equal(label?.getAttribute('text-anchor'), 'middle');
		assert.equal(label?.getAttribute('font-weight'), '600');
		assert.equal(imageDocument.querySelector('path')?.getAttribute('stroke-dasharray'), '2 2');
		assert.equal(imageDocument.querySelector('circle')?.hasAttribute('fill'), false);
		assert.equal(imageDocument.querySelector('script, foreignObject, iframe, image, animate, [onload]'), null);

		assert.equal(decodeChatGPTReply('```svg\n' + svg + '\n```').richContent, undefined);
	});

	test('shows media and opaque components without running or loading their source', () => {
		const source = '<video src="https://invalid.test/movie" title="Demo"/>\n\n<img src="file:///private.png" alt="Picture"/>\n\n<icon name="arrow-right"/><icon name="new-icon"/><icon name="constructor"/>';
		const html = render(source);
		assert.match(html, /Demo[\s\S]*Picture[\s\S]*→[\s\S]*new-icon[\s\S]*constructor/u);
		assert.doesNotMatch(html, /<video|<img|src=/u);
		assert.equal(decodeChatGPTReply(source).resources.length, 2);
	});

	test('retains remote images as loadable resources while allowing embedded raster images', () => {
		const source = '![Diagram](https://invalid.test/private-image)\n\n![Local](file:///private.png)\n\n![Embedded](data:image/png;base64,AAAA)';
		const html = render(source);
		assert.match(html, /Diagram[\s\S]*Local[\s\S]*<img src="data:image\/png;base64,AAAA"/u);
		assert.equal(decodeChatGPTReply(source).resources.length, 2);
		assert.doesNotMatch(html, /src="(?:https|file)/u);
	});

	test('keeps paragraphs when wrappers are unmatched or stream chunks end inside an opening tag', () => {
		const html = render('Before\n\n<FutureCard>\nFirst paragraph\n\nSecond paragraph\n\n<Chart title="unfinished');
		assert.match(html, /Before[\s\S]*First paragraph[\s\S]*Second paragraph/u);
		assert.doesNotMatch(html, /ash-chat-rich-fallback/u);
		assert.doesNotMatch(html, /<FutureCard|<Chart/u);
		assert.match(render('<box>'.repeat(40) + 'Deep content' + '</box>'.repeat(40)), /Deep content/u);
	});

	test('preserves literal markup, autolinks and HTML code while omitting only annotation tokens', () => {
		const source = '`<FutureCard>example</FutureCard>`\n\n```jsx\n<Chart data={values}/>\n```\n\n<code>&lt;tag&gt; and &lt;box&gt;literal&lt;/box&gt;</code>\n\n<https://example.com/source>\n\nBefore <Cite refs={[["private-reference"]]}/> after';
		const html = render(source);
		assert.match(html, /&lt;FutureCard&gt;example&lt;\/FutureCard&gt;/u);
		assert.match(html, /&lt;Chart data=\{values\}\/&gt;/u);
		assert.match(html, /&lt;box&gt;literal&lt;\/box&gt;/u);
		assert.match(html, /href="https:\/\/example.com\/source"/u);
		assert.match(html, /Before  after/u);
		assert.doesNotMatch(html, /private-reference/u);
		assert.doesNotMatch(getChatGPTRichContentText(source), /private-reference/u);
	});
});
