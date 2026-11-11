import '../../../../../editor/test/browser/testEditorDom.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IExtensionHostApi } from '../../../../../platform/extensions/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../../../platform/extensions/browser/extensionHostApi.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ChatContentMarkdownRenderer } from '../../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { chatMarkdownRichContentExtension, renderChatRichContentText } from '../../../../../workbench/contrib/chat/browser/widget/chatMarkdownRichContent.js';
import { decodeChatGPTReply } from '../../browser/chatGPTRichContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ChatGPTReference } from '../../browser/chatGPTClient.js';

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
		const html = render(source);
		assert.match(html, /Before[\s\S]*<strong>杭州周末<\/strong>[\s\S]*两间房共1160元。[\s\S]*After/u);
		assert.doesNotMatch(html, /:::|variant=|64821|quoted title/u);
		const text = getChatGPTRichContentText(source);
		assert.match(text, /Before[\s\S]*杭州周末[\s\S]*1160[\s\S]*After/u);
		assert.doesNotMatch(text, /:::|variant=|64821/u);
	});

	test('keeps writing text while streaming and preserves writing examples inside code', () => {
		assert.match(render(':::writing{variant="chat_message"}**Visible draft**'), /<strong>Visible draft<\/strong>/u);
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
		assert.equal(root.querySelectorAll('details.ash-chat-citation').length, 2);
		assert.match(root.querySelector('details')?.textContent ?? '', /CSV documentation[\s\S]*Read and write tabular data/u);
		assert.equal(root.querySelector('a')?.href, references[0]!.url);
		const annotatedLink = [...root.querySelectorAll('a')].find(link => link.textContent === 'Python docs');
		assert.equal(annotatedLink?.href, references[0]!.url);
		assert.equal(annotatedLink?.title, 'CSV documentation\nRead and write tabular data.');
		assert.equal(root.querySelector('code')?.textContent, 'citeturn2search1');
		assert.equal((root.textContent?.match(/cite/gu) ?? []).length, 1);
		assert.match(getChatGPTRichContentText(source, references), /CSV documentation[\s\S]*Read and write tabular data/u);
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
		assert.equal(root.querySelector('ol details.ash-chat-citation a')?.textContent, 'Source');
		assert.deepEqual([...root.querySelectorAll('ol ul > li')].map(item => item.textContent), ['GPUI Kit', 'Blocked link', link]);
		assert.equal(root.querySelector('code')?.textContent, link);
		assert.match(root.querySelector('blockquote')?.textContent ?? '', /GPUI Kit/u);
		assert.equal(root.querySelector('td')?.textContent, 'GPUI Kit');
		root.querySelector('code')?.remove();
		assert.doesNotMatch(root.textContent ?? '', /[\uE200-\uE202]|UI library/u);
		assert.match(getChatGPTRichContentText(source, references), /使用 Rust。[\s\S]*Source[\s\S]*GPUI Kit/u);
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
		const markers = [...names.map(name => `<icon name="${name}"/>`), '<icon name="key-round" label="Key"/>'];
		const root = document.createElement('div');
		root.innerHTML = render(markers.join(' '));
		assert.deepEqual(Array.from(root.querySelectorAll<HTMLElement>('[data-ash-icon-id]'), icon => icon.dataset.ashIconId), [
			'check', 'close', 'arrow-down', 'arrow-up', 'arrow-left', 'arrow-right', 'sort', 'add', 'remove', 'info', 'warning', 'file',
		]);
		assert.equal(root.querySelector('.ash-chat-rich-icon:last-child')?.textContent, 'Key');
		assert.deepEqual(markers.map(marker => getChatGPTRichContentText(marker).trim()), ['✓', '×', '↓', '↑', '←', '→', '⇅', '+', '−', 'ⓘ', '⚠', 'file', 'Key']);
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

	test('shows media and opaque components without running or loading their source', () => {
		const source = '<svg><title>Architecture</title><text>Node A</text><path d="M0 0"/></svg>\n\n<video src="https://invalid.test/movie" title="Demo"/>\n\n<img src="file:///private.png" alt="Picture"/>\n\n<icon name="arrow-right"/><icon name="new-icon"/><icon name="constructor"/>';
		const html = render(source);
		assert.match(html, /Architecture[\s\S]*Node A[\s\S]*Demo[\s\S]*Picture[\s\S]*→[\s\S]*new-icon[\s\S]*constructor/u);
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
