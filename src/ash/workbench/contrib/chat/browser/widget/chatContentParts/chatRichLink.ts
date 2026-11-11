import './media/chatRichLink.css';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { appendLabelIcon } from '../../../../../../base/browser/ui/iconlabel/iconLabels.js';
import { createPixelSpinner, type IPixelSpinner } from '../../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { autorun, observableFromEvent, type IObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../../platform/agentHost/common/openSessionLink.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILinkPresentationService, type ILinkPresentation } from '../../../../../../platform/dataChannel/common/dataChannel.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { colorCssVariable } from '../../../../../../platform/theme/common/colorUtils.js';
import { GitHubResourcePresentation, type IGitHubResourceHover } from '../../../../github/browser/githubResourceHover.js';
import { ISessionSummaryHoverService } from '../../agentSessions/sessionSummaryHoverService.js';
import { chatCitationLinkClass, chatExternalLinkClass, chatSourcePreviewClass } from '../chatMarkdownRichContent.js';

export function createChatLinkPreview(document: Document, links: readonly HTMLAnchorElement[]): HTMLElement {
	const list = document.createElement('ul');
	list.className = 'ash-chat-link-preview';
	for (const link of links) {
		const item = document.createElement('li');
		item.append(link);
		list.append(item);
	}
	return list;
}

function createExternalLinkPreview(anchor: HTMLAnchorElement, href: string): HTMLElement {
	const document = anchor.ownerDocument;
	return createChatLinkPreview(document, [createChatLinkPreviewRow(document, href, anchor.textContent?.trim() || href)]);
}

export function createChatLinkPreviewRow(document: Document, href: string, label: string): HTMLAnchorElement {
	const domain = URL.parse(href)?.hostname;
	const row = document.createElement('a');
	row.className = chatCitationLinkClass;
	row.setAttribute('href', href);
	appendLabelIcon(row, domain === 'github.com' ? Lxicon.github : Lxicon.browserExplore);
	const content = document.createElement('span');
	content.className = 'ash-chat-link-preview-text';
	const text = label.trim() || domain || href;
	if (domain && domain !== text) {
		const label = document.createElement('span');
		label.className = 'ash-chat-citation-domain';
		label.textContent = domain;
		content.append(label, ' ');
	}
	const title = document.createElement('span');
	title.className = 'ash-chat-citation-title';
	title.textContent = text;
	content.append(title);
	row.append(content);
	appendLabelIcon(row, Lxicon.linkExternal);
	return row;
}

/** Presents metadata on the existing anchor so its target, event handlers and focus stay intact. */
class ChatRichLink extends Disposable {
	static mount(element: HTMLElement, authoredLabel: HTMLSpanElement): ChatRichLink {
		return new ChatRichLink(element, authoredLabel);
	}

	private readonly contents: readonly ChildNode[];
	private readonly ariaLabel: string | null;
	private readonly spinner = this._register(new MutableDisposable<IPixelSpinner>());
	private readonly fields: readonly HTMLSpanElement[];

	private constructor(
		readonly element: HTMLElement,
		readonly authoredLabel: HTMLSpanElement,
	) {
		super();
		this.contents = [...element.childNodes];
		this.ariaLabel = element.getAttribute('aria-label');
		this.fields = ['title', 'reference', 'detail', 'status', 'secondary-status', 'changes'].map(name => {
			const span = element.ownerDocument.createElement('span');
			span.className = `ash-chat-rich-link-${name}`;
			return span;
		});
	}

	update(presentation: ILinkPresentation): void {
		const values = [
			presentation.title,
			presentation.reference,
			presentation.detail,
			presentation.status?.label,
			presentation.secondaryStatus?.label,
			presentation.changes ? `+${presentation.changes.insertions} −${presentation.changes.deletions}` : undefined,
		];
		const contents: (Node | string)[] = [];
		if (!presentation.title) {
			this.authoredLabel.append(...this.contents);
			contents.push(this.authoredLabel);
		}
		for (const [index, field] of this.fields.entries()) {
			const value = values[index];
			if (!value) continue;
			field.textContent = value;
			if (contents.length) contents.push(' · ');
			contents.push(field);
		}
		this.spinner.clear();
		this.element.replaceChildren(...contents);
		this.element.setAttribute('aria-label', presentation.ariaLabel ?? this.element.textContent ?? '');
		this.element.setAttribute('aria-busy', String(presentation.isLoading === true));
		this.element.classList.add('ash-chat-rich-link');
		this.element.classList.toggle('loading', presentation.isLoading === true);
		if (presentation.isLoading) {
			this.spinner.value = createPixelSpinner();
			this.element.prepend(this.spinner.value.element, ' ');
		} else if (presentation instanceof GitHubResourcePresentation && presentation.pullRequestIcon) {
			const icon = presentation.pullRequestIcon;
			const glyph = appendLabelIcon(this.element, icon);
			glyph.style.color = `var(${colorCssVariable(icon.color!.id)})`;
			this.element.prepend(glyph);
		}
	}

	restore(): void {
		this.spinner.clear();
		this.element.replaceChildren(...this.contents);
		if (this.ariaLabel === null) {
			this.element.removeAttribute('aria-label');
		} else {
			this.element.setAttribute('aria-label', this.ariaLabel);
		}
		this.element.removeAttribute('aria-busy');
		this.element.classList.remove('ash-chat-rich-link', 'loading');
	}

	protected override disposeCore(): void {
		this.restore();
		super.disposeCore();
	}
}

/** Binds presentation and hover behavior for the lifetime of a rendered anchor. */
export class ChatRichLinkDecorator extends Disposable {
	private readonly verbosity: IObservable<boolean>;

	constructor(
		private readonly openLink: (href: string) => void,
		@ILinkPresentationService private readonly links: ILinkPresentationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configuration: IConfigurationService,
		@ISessionSummaryHoverService private readonly summaryHover: ISessionSummaryHoverService,
	) {
		super();
		this.verbosity = observableFromEvent(this, configuration.onDidChangeConfiguration, () => configuration.getValue<boolean>(AccessibilityVerbositySettingId.GitHub));
	}

	decorate(anchor: HTMLAnchorElement, href: string, store: DisposableStore): boolean {
		const resource = this.links.linkPresentationRules.length ? parseLinkResource(href) : undefined;
		const external = anchor.classList.contains(chatExternalLinkClass);
		const compact = anchor.classList.contains(chatCitationLinkClass) || external;
		const preview = anchor.classList.contains(chatSourcePreviewClass) ? anchor.getAttribute('title')?.trim() : undefined;
		const linkPreview = external ? createExternalLinkPreview(anchor, href) : undefined;
		const fallback = linkPreview ?? (preview || (compact ? href : undefined));
		const dialogLabel = external ? localize('chat.link.preview', 'Link preview') : undefined;
		const rule = resource && this.links.getLinkPresentationRule(resource);
		if (!rule || !resource) {
			if (!fallback) return false;
			const hover = store.add(this.hoverService.setupHover({ target: anchor, content: fallback, dialogLabel }));
			if (linkPreview) store.add(bindChatLinkPreviewActivation(linkPreview, anchor, () => hover.hide(), this.openLink));
			return true;
		}

		const view = compact ? undefined : store.add(ChatRichLink.mount(anchor, anchor.ownerDocument.createElement('span')));
		const ariaDescription = anchor.getAttribute('aria-description');
		const restoreDescription = (): void => {
			if (ariaDescription === null) { anchor.removeAttribute('aria-description'); }
			else { anchor.setAttribute('aria-description', ariaDescription); }
			delete anchor.dataset.githubContent;
		};
		store.add(toDisposable(restoreDescription));
		const active = store.add(new MutableDisposable<DisposableStore>());
		const card = store.add(new MutableDisposable<IGitHubResourceHover>());
		let presentation: ILinkPresentation | undefined;
		const initialContent = compact ? () => {
			// Hover renders synchronously. Wait until it has mounted before subscribing to live updates.
			queueMicrotask(() => { if (!store.isDisposed && hover.visible) startWatching(); });
			return fallback;
		} : fallback;
		const hover = store.add(this.hoverService.setupHover({
			target: anchor,
			content: initialContent,
			dialogLabel,
			trapFocus: true,
			onDidHide: () => {
				card.clear();
				if (compact && !store.isDisposed) {
					active.clear();
					presentation = undefined;
					restoreDescription();
					hover.update(initialContent);
				}
			},
		}));
		if (linkPreview) store.add(bindChatLinkPreviewActivation(linkPreview, anchor, () => hover.hide(), this.openLink));
		const startWatching = (): void => {
			if (active.value) return;
			const watcher = this.links.createLinkPresentationWatcher(rule.id, resource);
			if (!watcher) return;
			const scope = active.value = new DisposableStore();
			scope.add(watcher);
			scope.add(autorun(reader => {
				const value = presentation = watcher.presentation.read(reader);
				if (!value || (compact && (value.isLoading || value.status?.kind === 'error'))) {
					card.clear();
					restoreDescription();
					view?.restore();
					hover.update(fallback);
					return;
				}
				view?.update(value);
				const detail = value.tooltip ?? (compact ? value.title : anchor.textContent) ?? href;
				const content = (token: CancellationToken): HTMLElement | string => {
					card.clear();
					if (value instanceof GitHubResourcePresentation) {
						card.value = value.createHover();
						if (linkPreview) {
							const container = anchor.ownerDocument.createElement('div');
							container.append(linkPreview, card.value.element);
							return container;
						}
						if (!compact || !preview) return card.value.element;
						const container = anchor.ownerDocument.createElement('div');
						const source = anchor.ownerDocument.createElement('div');
						source.className = 'ash-chat-link-source-preview';
						source.textContent = preview;
						container.append(card.value.element, source);
						return container;
					}
					if (resource.scheme === OPEN_SESSION_LINK_SCHEME) {
						return this.summaryHover.createHoverElement(resource, token, anchor.ownerDocument) ?? detail;
					}
					if (linkPreview) {
						const container = anchor.ownerDocument.createElement('div');
						const text = anchor.ownerDocument.createElement('div');
						text.className = 'ash-chat-link-source-preview';
						text.textContent = detail;
						container.append(linkPreview, text);
						return container;
					}
					return compact && preview && preview !== detail ? `${preview}\n\n${detail}` : detail;
				};
				const focusedIndex = card.value?.tabbableElements.indexOf(anchor.ownerDocument.activeElement as HTMLElement) ?? -1;
				hover.update(content);
				if (focusedIndex >= 0) card.value?.tabbableElements[focusedIndex]?.focus();
				restoreDescription();
				if (value instanceof GitHubResourcePresentation) {
					anchor.dataset.githubContent = compact && preview ? `${preview}\n\n${detail}` : detail;
					if (this.verbosity.read(reader)) {
						anchor.setAttribute('aria-description', localize('github.helpHint', 'Press F2 to focus link details. Open accessibility help for keyboard instructions.'));
					}
				}
			}));
		};
		store.add(addDisposableListener(anchor, 'keydown', event => {
			if (event.key !== 'F2' || !(presentation instanceof GitHubResourcePresentation)) return;
			event.preventDefault();
			event.stopPropagation();
			hover.show();
			card.value?.tabbableElements[0]?.focus();
		}));
		if (!compact) startWatching();
		return true;
	}
}

export function bindChatLinkPreviewActivation(preview: HTMLElement, trigger: HTMLElement, hide: () => void, openLink: (href: string) => void): IDisposable {
	return addDisposableListener(preview, 'click', event => {
		const href = (event.target as Element | null)?.closest?.('a[href]')?.getAttribute('href');
		if (!href) return;
		event.preventDefault();
		event.stopPropagation();
		if (preview.contains(preview.ownerDocument.activeElement)) trigger.focus({ preventScroll: true });
		hide();
		openLink(href);
	});
}


function parseLinkResource(href: string): URI | undefined {
	try {
		return URI.parse(href);
	} catch {
		// An allowed Markdown URL can still be outside the resource URI contract.
		return undefined;
	}
}
