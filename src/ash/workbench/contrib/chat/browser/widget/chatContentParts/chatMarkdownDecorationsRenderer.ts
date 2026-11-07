import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { appendLabelIcon } from '../../../../../../base/browser/ui/iconlabel/iconLabels.js';
import { createPixelSpinner, type IPixelSpinner } from '../../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, type IObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../../platform/agentHost/common/openSessionLink.js';
import { ILinkPresentationService } from '../../../../../../platform/dataChannel/common/dataChannel.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { localize } from '../../../../../../nls.js';
import { colorCssVariable } from '../../../../../../platform/theme/common/colorUtils.js';
import { GitHubResourcePresentation, type IGitHubResourceHover } from '../../../../github/browser/githubResourceHover.js';
import { ISessionSummaryHoverService } from '../../agentSessions/sessionSummaryHoverService.js';

/** Owns provider decorations for the live, sanitized anchors of one response. */
export class ChatMarkdownDecorationsRenderer extends Disposable {
	private readonly bindings = this._register(new DisposableMap<HTMLAnchorElement, DisposableStore>());
	private readonly verbosity: IObservable<boolean>;

	constructor(
		private readonly root: HTMLElement,
		@ILinkPresentationService private readonly links: ILinkPresentationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configuration: IConfigurationService,
		@ISessionSummaryHoverService private readonly summaryHover: ISessionSummaryHoverService,
	) {
		super();
		this.verbosity = observableFromEvent(this, configuration.onDidChangeConfiguration, () => configuration.getValue<boolean>(AccessibilityVerbositySettingId.GitHub));
		this._register(links.onDidChangeLinkPresentationRules(() => {
			this.bindings.clearAndDisposeAll();
			this.reconcile();
		}));
		this.reconcile();
	}

	reconcile(): void {
		for (const anchor of this.bindings.keys()) {
			if (!this.root.contains(anchor)) this.bindings.deleteAndDispose(anchor);
		}
		if (this.links.linkPresentationRules.length) this.bind(this.root.querySelectorAll<HTMLAnchorElement>('a[href]'));
	}

	applyPatch(removed: readonly ChildNode[], added: readonly ChildNode[]): void {
		if (this.bindings.size) {
			for (const anchor of anchorsIn(removed)) this.bindings.deleteAndDispose(anchor);
		}
		if (this.links.linkPresentationRules.length) this.bind(anchorsIn(added));
	}

	private bind(anchors: Iterable<HTMLAnchorElement>): void {
		for (const anchor of anchors) {
			const href = anchor.getAttribute('href');
			if (!href || this.bindings.has(anchor)) continue;
			const resource = URI.parse(href);
			const rule = this.links.getLinkPresentationRule(resource);
			if (!rule) {
				continue;
			}
			const watcher = this.links.createLinkPresentationWatcher(rule.id, resource);
			if (!watcher) {
				continue;
			}
			const binding = this.bindings.set(anchor, new DisposableStore());
			const contents = [...anchor.childNodes];
			const title = anchor.getAttribute('title');
			const ariaLabel = anchor.getAttribute('aria-label');
			const ariaDescription = anchor.getAttribute('aria-description');
			binding.add(watcher);
			const spinner = binding.add(new MutableDisposable<IPixelSpinner>());
			const restore = (): void => {
				spinner.clear();
				anchor.replaceChildren(...contents);
				if (title === null) { anchor.removeAttribute('title'); } else { anchor.setAttribute('title', title); }
				if (ariaLabel === null) { anchor.removeAttribute('aria-label'); } else { anchor.setAttribute('aria-label', ariaLabel); }
				if (ariaDescription === null) { anchor.removeAttribute('aria-description'); } else { anchor.setAttribute('aria-description', ariaDescription); }
				anchor.removeAttribute('aria-busy');
				anchor.classList.remove('ash-chat-rich-link', 'loading');
				delete anchor.dataset.githubContent;
			};
			binding.add(toDisposable(restore));
			const card = binding.add(new MutableDisposable<IGitHubResourceHover>());
			const hover = binding.add(this.hoverService.setupHover({
				target: anchor,
				content: undefined,
				trapFocus: true,
				onDidHide: () => card.clear(),
			}));
			binding.add(addDisposableListener(anchor, 'keydown', event => {
				if (event.key !== 'F2' || !(watcher.presentation.get() instanceof GitHubResourcePresentation)) { return; }
				event.preventDefault();
				event.stopPropagation();
				hover.show();
				card.value?.tabbableElements[0]?.focus();
			}));
			binding.add(autorun(reader => {
				const presentation = watcher.presentation.read(reader);
				if (!presentation) {
					hover.update(undefined);
					card.clear();
					restore();
					return;
				}
				const label = [
					presentation.title ?? contents.map(node => node.textContent).join(''),
					presentation.reference,
					presentation.detail,
					presentation.status?.label,
					presentation.secondaryStatus?.label,
					presentation.changes ? `+${presentation.changes.insertions} −${presentation.changes.deletions}` : undefined,
				].filter(value => value !== undefined && value !== '').join(' · ');
				spinner.clear();
				anchor.textContent = label;
				if (presentation.isLoading) {
					spinner.value = createPixelSpinner();
					anchor.prepend(spinner.value.element, ' ');
				} else if (presentation instanceof GitHubResourcePresentation && presentation.pullRequestIcon) {
					const icon = presentation.pullRequestIcon;
					const glyph = appendLabelIcon(anchor, icon);
					glyph.style.color = `var(${colorCssVariable(icon.color!.id)})`;
					anchor.prepend(glyph);
				}
				const content = (token: CancellationToken): HTMLElement | string => {
					card.clear();
					if (presentation instanceof GitHubResourcePresentation) {
						card.value = presentation.createHover();
						return card.value.element;
					}
					if (resource.scheme === OPEN_SESSION_LINK_SCHEME) {
						return this.summaryHover.createHoverElement(resource, token, anchor.ownerDocument) ?? presentation.tooltip ?? label;
					}
					return presentation.tooltip ?? label;
				};
				const focusedIndex = card.value?.tabbableElements.indexOf(anchor.ownerDocument.activeElement as HTMLElement) ?? -1;
				hover.update(content);
				if (focusedIndex >= 0) {
					card.value?.tabbableElements[focusedIndex]?.focus();
				}
				if (presentation instanceof GitHubResourcePresentation) {
					anchor.dataset.githubContent = presentation.tooltip ?? label;
					if (this.verbosity.read(reader)) {
						anchor.setAttribute('aria-description', localize('github.helpHint', 'Press F2 to focus link details. Open accessibility help for keyboard instructions.'));
					} else if (ariaDescription === null) {
						anchor.removeAttribute('aria-description');
					} else {
						anchor.setAttribute('aria-description', ariaDescription);
					}
				}
				anchor.setAttribute('aria-label', presentation.ariaLabel ?? label);
				anchor.setAttribute('aria-busy', String(presentation.isLoading === true));
				anchor.classList.add('ash-chat-rich-link');
				anchor.classList.toggle('loading', presentation.isLoading === true);
			}));
		}
	}
}

function* anchorsIn(nodes: readonly ChildNode[]): IterableIterator<HTMLAnchorElement> {
	for (const node of nodes) {
		if (node.nodeType !== 1) continue;
		const element = node as Element;
		if (element.tagName === 'A') yield element as HTMLAnchorElement;
		yield* element.querySelectorAll<HTMLAnchorElement>('a');
	}
}
