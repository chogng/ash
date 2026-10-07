import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { appendLabelIcon } from '../../../../../../base/browser/ui/iconlabel/iconLabels.js';
import { createPixelSpinner, type IPixelSpinner } from '../../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, type IObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ILinkPresentationService } from '../../../../../../platform/dataChannel/common/dataChannel.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { localize } from '../../../../../../nls.js';
import { colorCssVariable } from '../../../../../../platform/theme/common/colorUtils.js';
import { GitHubResourcePresentation, type IGitHubResourceHover } from '../../../../github/browser/githubResourceHover.js';

/** Owns provider decorations for the sanitized anchors in one rendered Markdown block. */
export class ChatMarkdownDecorationsRenderer extends Disposable {
	private readonly bindings = this._register(new DisposableStore());
	private readonly verbosity: IObservable<boolean>;
	private readonly anchors: readonly { readonly anchor: HTMLAnchorElement; readonly contents: readonly ChildNode[]; readonly title: string | null; readonly ariaLabel: string | null; readonly ariaDescription: string | null; }[];

	constructor(root: HTMLElement, @ILinkPresentationService private readonly links: ILinkPresentationService, @IHoverService private readonly hoverService: IHoverService, @IConfigurationService configuration: IConfigurationService) {
		super();
		this.verbosity = observableFromEvent(this, configuration.onDidChangeConfiguration, () => configuration.getValue<boolean>(AccessibilityVerbositySettingId.GitHub));
		this.anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map(anchor => ({
			anchor,
			contents: [...anchor.childNodes],
			title: anchor.getAttribute('title'),
			ariaLabel: anchor.getAttribute('aria-label'),
			ariaDescription: anchor.getAttribute('aria-description'),
		}));
		this._register(links.onDidChangeLinkPresentationRules(() => this.render()));
		this.render();
	}

	private render(): void {
		this.bindings.clear();
		for (const { anchor, contents, title, ariaLabel, ariaDescription } of this.anchors) {
			const resource = URI.parse(anchor.getAttribute('href')!);
			const rule = this.links.getLinkPresentationRule(resource);
			if (!rule) {
				continue;
			}
			const watcher = this.links.createLinkPresentationWatcher(rule.id, resource);
			if (!watcher) {
				continue;
			}
			this.bindings.add(watcher);
			const spinner = this.bindings.add(new MutableDisposable<IPixelSpinner>());
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
			this.bindings.add(toDisposable(restore));
			const card = this.bindings.add(new MutableDisposable<IGitHubResourceHover>());
			const hover = this.bindings.add(this.hoverService.setupHover({
				target: anchor,
				content: undefined,
				trapFocus: true,
				onDidHide: () => card.clear(),
			}));
			this.bindings.add(addDisposableListener(anchor, 'keydown', event => {
				if (event.key !== 'F2' || !(watcher.presentation.get() instanceof GitHubResourcePresentation)) { return; }
				event.preventDefault();
				event.stopPropagation();
				hover.show();
				card.value?.tabbableElements[0]?.focus();
			}));
			this.bindings.add(autorun(reader => {
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
				const content = (): HTMLElement | string => {
					card.clear();
					if (presentation instanceof GitHubResourcePresentation) {
						card.value = presentation.createHover();
						return card.value.element;
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
