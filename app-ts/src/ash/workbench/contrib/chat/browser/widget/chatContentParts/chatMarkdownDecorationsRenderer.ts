import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ILinkPresentationService } from '../../../../../../platform/dataChannel/common/dataChannel.js';

/** Owns provider decorations for the sanitized anchors in one rendered Markdown block. */
export class ChatMarkdownDecorationsRenderer extends Disposable {
	private readonly bindings = this._register(new DisposableStore());
	private readonly anchors: readonly { readonly anchor: HTMLAnchorElement; readonly contents: readonly ChildNode[]; readonly title: string | null; readonly ariaLabel: string | null }[];

	constructor(root: HTMLElement, @ILinkPresentationService private readonly links: ILinkPresentationService) {
		super();
		this.anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map(anchor => ({
			anchor,
			contents: [...anchor.childNodes],
			title: anchor.getAttribute('title'),
			ariaLabel: anchor.getAttribute('aria-label'),
		}));
		this._register(links.onDidChangeLinkPresentationRules(() => this.render()));
		this.render();
	}

	private render(): void {
		this.bindings.clear();
		for (const { anchor, contents, title, ariaLabel } of this.anchors) {
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
			const restore = (): void => {
				anchor.replaceChildren(...contents);
				if (title === null) { anchor.removeAttribute('title'); } else { anchor.setAttribute('title', title); }
				if (ariaLabel === null) { anchor.removeAttribute('aria-label'); } else { anchor.setAttribute('aria-label', ariaLabel); }
				anchor.removeAttribute('aria-busy');
				anchor.classList.remove('ash-chat-rich-link', 'loading');
			};
			this.bindings.add(toDisposable(restore));
			this.bindings.add(autorun(reader => {
				const presentation = watcher.presentation.read(reader);
				if (!presentation) {
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
				anchor.textContent = label;
				anchor.title = presentation.tooltip ?? label;
				anchor.setAttribute('aria-label', presentation.ariaLabel ?? label);
				anchor.setAttribute('aria-busy', String(presentation.isLoading === true));
				anchor.classList.add('ash-chat-rich-link');
				anchor.classList.toggle('loading', presentation.isLoading === true);
			}));
		}
	}
}
