import { renderMarkdown } from '../../../src/ash/base/browser/markdownRenderer.js';
import dompurify from '../../../src/ash/base/browser/dompurify/dompurify.js';
import { safeSetInnerHtml, sanitizeHtml, sanitizeHtmlToFragment } from '../../../src/ash/base/browser/domSanitize.js';
import '../../../src/ash/base/browser/markdownRenderer.css';
import { DisposableStore, MutableDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { createCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { IMarkdownRendererService } from '../../../src/ash/platform/markdown/browser/markdownRenderer.js';
import { ChatMarkdownContentPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.js';
import '../../../src/ash/base/browser/ui/styles.css';

// This isolates the Markdown service boundary from the full chat/voice fixture.
const chatResources = new DisposableStore();
const chatServices = chatResources.add(createTestEditorServices(undefined, createCodeEditorServices(chatResources)));
const chatPart = chatResources.add(new MutableDisposable<ChatMarkdownContentPart>());
let defaultCodeCalls = 0;
chatServices.get(IMarkdownRendererService).setDefaultCodeBlockRenderer({
	renderCodeBlock: async () => {
		defaultCodeCalls += 1;
		return document.createElement('code');
	}
});

const markdown = 'a<em>b</em>c and `<span>code</span>`\n\n- [x] Done\n\n[Open](https://example.com)';
const openedLinks: string[] = [];
const plain = renderMarkdown({ value: markdown }, {
	ownerDocument: document,
	actionHandler: target => openedLinks.push(target)
});
const supported = renderMarkdown({ value: markdown, supportHtml: true }, {
	ownerDocument: document
});
const advanced = renderMarkdown({
	value: '> [!NOTE]\n> Read $(info)\n\n![pixel](data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=|width=32,height=16)\n\n**bold',
	supportAlertSyntax: true,
	supportThemeIcons: true,
}, {
	ownerDocument: document,
	fillInIncompleteTokens: true
});
const resources = renderMarkdown({ value: '[remote](ash-remote://ssh+host/src/file.ts) ![resource](ash-remote://ssh+host/images/pixel.gif|width=24)' }, {
	ownerDocument: document
});
const loadedResources: string[] = [];
let loadedResource = renderMarkdown({ value: '![pixel](ash-remote://ssh+host/images/pixel.gif)' }, {
	ownerDocument: document,
	imageResourceLoader: async (resource) => {
		loadedResources.push(resource.toString());
		return fetch('data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=').then(response => response.blob());
	}
});

document.getElementById('default')!.append(plain.element);
document.getElementById('html-supported')!.append(supported.element);
document.getElementById('advanced')!.append(advanced.element);
document.getElementById('resources')!.append(resources.element);
document.getElementById('loaded-resource')!.append(loadedResource.element);

declare global {
	interface Window {
		ashMarkdownIntegration: {
			dispose(): void;
			checkDomPurify(): { version: string; fragment: string; inPlace: string; hooked: string; };
			checkSanitizerPolicy(): Record<string, string>;
			openedLinks(): string[];
			loadedResources(): string[];
			clearLoadedResource(): void;
			streamChat(value: string, complete?: boolean): void;
			chatState(): { editors: number; defaultCodeCalls: number; };
			chatSelection(): readonly number[] | undefined;
		};
	}
}

window.ashMarkdownIntegration = {
	streamChat(value: string, complete = false): void {
		if (chatPart.value) {
			chatPart.value.tryIncrementalUpdate({ value }, !complete);
		} else {
			chatPart.value = chatServices.createInstance(ChatMarkdownContentPart, { ownerDocument: document, markdown: { value }, fillInIncompleteTokens: !complete });
			chatPart.value.domNode.id = 'service-chat';
			chatPart.value.domNode.style.width = '400px';
			document.body.append(chatPart.value.domNode);
			for (const editor of chatServices.get(ICodeEditorService).listCodeEditors()) editor.layout({ width: 400, height: 100 });
		}
	},
	chatState(): { editors: number; defaultCodeCalls: number; } {
		return { editors: chatServices.get(ICodeEditorService).listCodeEditors().length, defaultCodeCalls };
	},
	chatSelection(): readonly number[] | undefined {
		const selection = chatServices.get(ICodeEditorService).listCodeEditors()[0]?.getSelection();
		return selection ? [selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn] : undefined;
	},
	openedLinks(): string[] {
		return [...openedLinks];
	},
	loadedResources(): string[] {
		return [...loadedResources];
	},
	clearLoadedResource(): void {
		loadedResource.dispose();
		loadedResource = renderMarkdown({ value: 'Updated' }, { ownerDocument: document });
		document.getElementById('loaded-resource')!.replaceChildren(loadedResource.element);
	},
	checkSanitizerPolicy(): Record<string, string> {
		const defaultHtml = sanitizeHtml('<div onclick="alert(1)"><a href="javascript:alert(1)">link</a><script>alert(1)</script></div>').toString();
		const custom = sanitizeHtml('<custom-tag title="old">kept</custom-tag>', {
			allowedTags: { augment: ['custom-tag'] },
			allowedAttributes: {
				augment: [{ attributeName: 'title', shouldKeep: () => 'new' }],
			},
		}).toString();
		const relative = sanitizeHtml('<a href="guide.md">guide</a><img src="images/icon.png"><img src="//other.example/icon.png">', {
			allowRelativeLinkPaths: true,
			allowRelativeMediaPaths: true,
		}).toString();
		const filteredMedia = sanitizeHtml('<img src="https://example.com/private.png">', {
			mediaSourceIsAllowed: () => false,
		}).toString();
		const plaintext = sanitizeHtml('<div><unknown-tag>visible</unknown-tag></div>', {
			replaceWithPlaintext: true,
		}).toString();
		const target = document.createElement('div');
		safeSetInnerHtml(target, '<b>safe</b><script>alert(1)</script>');
		const fragment = sanitizeHtmlToFragment('<a href="https://example.com">safe</a>', { ownerDocument: document });
		return {
			defaultHtml,
			custom,
			relative,
			filteredMedia,
			plaintext,
			target: target.innerHTML,
			fragment: (fragment.firstElementChild as Element).outerHTML,
		};
	},
	checkDomPurify(): { version: string; fragment: string; inPlace: string; hooked: string; } {
		const fragment = dompurify.sanitize('<a href="javascript:alert(1)" onclick="alert(1)">safe</a><script>alert(1)</script>', { RETURN_DOM_FRAGMENT: true });
		const fragmentContainer = document.createElement('div');
		fragmentContainer.append(fragment);
		const inPlaceNode = document.createElement('div');
		inPlaceNode.innerHTML = '<img src="javascript:alert(1)" onerror="alert(1)"><strong>safe</strong>';
		dompurify.sanitize(inPlaceNode, { IN_PLACE: true });
		dompurify.addHook('afterSanitizeAttributes', element => element.removeAttribute('title'));
		try {
			return {
				version: dompurify.version,
				fragment: fragmentContainer.innerHTML,
				inPlace: inPlaceNode.outerHTML,
				hooked: dompurify.sanitize('<a title="remove me">safe</a>'),
			};
		} finally {
			dompurify.removeAllHooks();
		}
	},
	dispose(): void {
		chatResources.dispose();
		plain.dispose();
		supported.dispose();
		advanced.dispose();
		resources.dispose();
		loadedResource.dispose();
	},
};
