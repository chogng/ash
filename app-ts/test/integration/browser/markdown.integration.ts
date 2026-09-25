import { MarkdownElement } from '../../../src/ash/base/browser/markdownRenderer.js';
import dompurify from '../../../src/ash/base/browser/dompurify/dompurify.js';
import { safeSetInnerHtml, sanitizeHtml, sanitizeHtmlToFragment } from '../../../src/ash/base/browser/domSanitize.js';
import '../../../src/ash/base/browser/markdownRenderer.css';

const markdown = 'a<em>b</em>c and `<span>code</span>`\n\n- [x] Done\n\n[Open](https://example.com)';
const openedLinks: string[] = [];
const plain = new MarkdownElement({
	ownerDocument: document,
	markdown,
	linkHandler: target => openedLinks.push(target),
});
const supported = new MarkdownElement({
	ownerDocument: document,
	markdown: { value: markdown, supportHtml: true },
});
const advanced = new MarkdownElement({
	ownerDocument: document,
	markdown: {
		value: '> [!NOTE]\n> Read $(info)\n\n![pixel](data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=|width=32,height=16)\n\n**bold',
		supportAlertSyntax: true,
		supportThemeIcons: true,
	},
	fillInIncompleteTokens: true,
});
const resources = new MarkdownElement({
	ownerDocument: document,
	markdown: '[remote](ash-remote://ssh+host/src/file.ts) ![resource](ash-remote://ssh+host/images/pixel.gif|width=24)',
});
const loadedResources: string[] = [];
const loadedResource = new MarkdownElement({
	ownerDocument: document,
	markdown: '![pixel](ash-remote://ssh+host/images/pixel.gif)',
	imageResourceLoader: async resource => {
		loadedResources.push(resource.toString());
		return fetch('data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=').then(response => response.blob());
	},
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
			checkDomPurify(): { version: string; fragment: string; inPlace: string; hooked: string };
			checkSanitizerPolicy(): Record<string, string>;
			openedLinks(): string[];
			loadedResources(): string[];
			clearLoadedResource(): void;
		};
	}
}

window.ashMarkdownIntegration = {
	openedLinks(): string[] {
		return [...openedLinks];
	},
	loadedResources(): string[] {
		return [...loadedResources];
	},
	clearLoadedResource(): void {
		loadedResource.setMarkdown('Updated');
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
	checkDomPurify(): { version: string; fragment: string; inPlace: string; hooked: string } {
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
		plain.dispose();
		supported.dispose();
		advanced.dispose();
		resources.dispose();
		loadedResource.dispose();
	},
};
