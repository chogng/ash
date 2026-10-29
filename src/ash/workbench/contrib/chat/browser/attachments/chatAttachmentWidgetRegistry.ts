import type { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

export interface IChatAttachmentWidgetInstance extends IDisposable {
	readonly element: HTMLElement;
	readonly onDidDelete: Event<globalThis.Event>;
	readonly onDidOpen: Event<void>;
}

export type ChatAttachmentWidgetFactory = (
	attachment: ChatContextAttachment,
	options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
	container: HTMLElement,
) => IChatAttachmentWidgetInstance;

export interface IChatAttachmentWidgetRegistry {
	readonly _serviceBrand: undefined;
	registerFactory(kind: string, factory: ChatAttachmentWidgetFactory): IDisposable;
	/** The receiving input owns each created widget; unregistered kinds use its existing renderer. */
	createWidget(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
	): IChatAttachmentWidgetInstance | undefined;
}

export const IChatAttachmentWidgetRegistry = createServiceIdentifier<IChatAttachmentWidgetRegistry>('chatAttachmentWidgetRegistry');

/** Window-owned rendering registrations. References and their snapshots remain input-owned. */
export class ChatAttachmentWidgetRegistry extends Disposable implements IChatAttachmentWidgetRegistry {
	declare readonly _serviceBrand: undefined;
	private readonly factories = new Map<string, { readonly create: ChatAttachmentWidgetFactory; }>();

	constructor() {
		super();
		this._register(toDisposable(() => this.factories.clear()));
	}

	registerFactory(kind: string, factory: ChatAttachmentWidgetFactory): IDisposable {
		this.assertNotDisposed();
		const registration = { create: factory };
		this.factories.set(kind, registration);
		return toDisposable(() => {
			// Even re-registering the same function gives the replacement its own lifetime.
			if (this.factories.get(kind) === registration) this.factories.delete(kind);
		});
	}

	createWidget(
		attachment: ChatContextAttachment,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean; },
		container: HTMLElement,
	): IChatAttachmentWidgetInstance | undefined {
		this.assertNotDisposed();
		return this.factories.get(attachment.kind)?.create(attachment, options, container);
	}
}
