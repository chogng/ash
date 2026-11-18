import './media/chatPills.css';
import { getActiveElement, isHTMLElement } from '../../base/browser/dom.js';
import type { HoverContent } from '../../base/browser/ui/hover/hover.js';
import { Disposable, DisposableMap, type IDisposable } from '../../base/common/lifecycle.js';
import type { URI } from '../../base/common/uri.js';
import { createUuid } from '../../base/common/uuid.js';
import { Button, type IButtonOptions } from '../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { createChatImageHoverContent } from './chatImagePreview.js';
import { createChatPillHover } from './chatPillHover.js';

export const chatPillButtonClassName = 'ash-chat-pill-button';
export const chatPillsRowClassName = 'ash-chat-pills-row';

/** Creates a native pill trigger with the shared Button focus and tooltip behavior. */
export function createChatPillButton(container: HTMLElement, options: IButtonOptions): Button {
	const button = new Button(container, { ...defaultButtonStyles, size: 'small', ...options });
	button.domNode.classList.add(chatPillButtonClassName);
	return button;
}

/** A rendered entry owns its resource bindings and DOM lifetime. */
export interface IChatPill<T> extends IDisposable {
	readonly element: HTMLElement;
	update(entry: T): void;
}

interface IChatPillsWidgetOptions<T> {
	readonly getId: (entry: T) => string;
	readonly create: (entry: T) => IChatPill<T>;
	/** Keeps host-owned controls after the managed entries. */
	readonly before?: HTMLElement;
	readonly onRemoveFocused?: () => void;
}

/** Reconciles the rendered entries of a pill collection by stable ID. */
export class ChatPillsWidget<T> extends Disposable {
	private readonly pills = this._register(new DisposableMap<string, IChatPill<T>>());

	constructor(private readonly container: HTMLElement, private readonly options: IChatPillsWidgetOptions<T>) {
		super();
	}

	get size(): number { return this.pills.size; }

	update(entries: readonly T[]): void {
		const document = this.container.ownerDocument;
		const focused = getActiveElement(document);
		const nextEntries = new Map(entries.map(entry => [this.options.getId(entry), entry]));
		for (const [id, pill] of this.pills) {
			if (nextEntries.has(id)) continue;
			if (pill.element.contains(focused)) this.options.onRemoveFocused?.();
			this.pills.deleteAndDispose(id);
		}

		const rendered = [...nextEntries].map(([id, entry]) => {
			const pill = this.pills.get(id) ?? this.pills.set(id, this.options.create(entry));
			pill.update(entry);
			return pill.element;
		});
		let next: HTMLElement | null = this.options.before ?? null;
		for (let index = rendered.length - 1; index >= 0; index--) {
			const element = rendered[index]!;
			if (element.parentElement !== this.container || element.nextSibling !== next) {
				this.container.insertBefore(element, next);
			}
			next = element;
		}
		// Moving a retained pill can blur it. Leave any deliberate focus change from an entry in place.
		if (isHTMLElement(focused) && this.container.contains(focused) && getActiveElement(document) === document.body) {
			focused.focus({ preventScroll: true });
		}
	}
}

/** Supplies a pill hover for an image already captured by its owning attachment. */
export function createChatPillImagePreview(
	entry: { readonly label: string; readonly resource?: URI; readonly loadedImage: HTMLImageElement; readonly image: () => Blob; },
	ownerDocument: Document,
): HoverContent {
	const cacheKey = createUuid();
	return createChatPillHover({
		fallback: entry.label,
		sizing: 'preview',
		createContent: () => {
			const preview = createChatImageHoverContent(entry.resource, entry.label, entry.image, cacheKey,
				undefined, undefined, undefined, entry.label, true, () => {
					if (!entry.resource) preview.element.textContent = entry.label;
				}, { ownerDocument, loadedImage: entry.loadedImage });
			return preview;
		},
	});
}
