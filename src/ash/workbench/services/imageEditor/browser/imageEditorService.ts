import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import type { IImageEditorService, ImageEditorProvider, ImageEditorOptions, ImageEditorCapture } from '../common/imageEditorService.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';

export abstract class ImageEditorService extends Disposable implements IImageEditorService {
	private readonly providers = new Map<string, ImageEditorProvider & { readonly dispose: () => void }>();
	private attachmentHandler: { readonly run: (capture: ImageEditorCapture) => Promise<void>; readonly lifetime: AbortController } | undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	get available(): boolean {
		return !this.isDisposed && [...this.providers.values()].filter(provider => provider.default).length === 1;
	}
	get accessibilityHelp(): string {
		return this.available ? [...this.providers.values()].find(provider => provider.default)!.accessibilityHelp : '';
	}
	register(provider: ImageEditorProvider) {
		this.assertNotDisposed();
		if (this.providers.has(provider.id)) throw new TypeError('Duplicate image editor provider');
		const lifetime = new AbortController();
		const entry = {
			...provider,
			signal: AbortSignal.any([provider.signal, lifetime.signal]),
			dispose: () => lifetime.abort(),
		};
		this.providers.set(provider.id, entry);
		this.changed.fire();
		return toDisposable(() => {
			entry.dispose();
			if (this.providers.get(provider.id) === entry) {
				this.providers.delete(provider.id);
				this.changed.fire();
			}
		});
	}
	async resolve(source: 'screen' | 'selection', signal: AbortSignal, id?: string) {
		this.assertNotDisposed();
		const candidates = id ? [this.providers.get(id)].filter(value => !!value) : [...this.providers.values()].filter(provider => provider.default);
		if (candidates.length !== 1) throw new Error(localize('imageEditor.providerUnavailable', 'Enable one default image editor extension to edit images.'));
		const provider = candidates[0];
		const requestSignal = AbortSignal.any([signal, provider.signal]);
		requestSignal.throwIfAborted();
		const view = await provider.resolve(source, requestSignal);
		requestSignal.throwIfAborted();
		return { view, displayName: provider.displayName, signal: requestSignal };
	}
	registerAttachmentHandler(handler: (capture: ImageEditorCapture) => Promise<void>) {
		this.assertNotDisposed();
		if (this.attachmentHandler) throw new Error('An image attachment target is already registered');
		const entry = { run: handler, lifetime: new AbortController() };
		this.attachmentHandler = entry;
		return toDisposable(() => {
			entry.lifetime.abort();
			if (this.attachmentHandler === entry) this.attachmentHandler = undefined;
		});
	}
	async show(options: ImageEditorOptions, signal: AbortSignal): Promise<void> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		// Capture belongs to the image interaction. Acquire a chat draft only after
		// Add to Chat returns pixels; copy, save and cancel never open a chat.
		const image = await this.capture(signal, { ...options, defaultAction: 'copy' });
		if (!image || signal.aborted || this.isDisposed) return;
		const handler = this.attachmentHandler;
		if (!handler) throw new Error(localize('imageEditor.attachmentUnavailable', 'No image attachment target is registered.'));
		await handler.run(async draftSignal => {
			if (signal.aborted || draftSignal.aborted || handler.lifetime.signal.aborted) return undefined;
			return image;
		});
	}
	abstract capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined>;
	override dispose(): void {
		this.attachmentHandler?.lifetime.abort();
		this.attachmentHandler = undefined;
		for (const provider of this.providers.values()) provider.dispose();
		this.providers.clear();
		super.dispose();
	}
}
