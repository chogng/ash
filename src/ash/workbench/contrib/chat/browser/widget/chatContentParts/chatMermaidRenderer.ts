import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { createObjectUrl } from '../../../../../../base/browser/fileAccess.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../../../base/common/types.js';
import { localize } from '../../../../../../nls.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot } from '../../../../../../platform/extensions/common/extensionHostApi.js';
import { isDarkColorScheme } from '../../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';

const extensionId = 'ash.markdown-language-features';
const channel = 'markdown.mermaid.render.v1';
const sourceLimit = 8 * 1024;
const outputLimit = 128 * 1024;

/** Only a real, closed Markdown fence can request a diagram. */
export function isClosedMermaidFence(raw: string | undefined): boolean {
	if (!raw || raw.length > sourceLimit + 1024) { return false; }
	const opening = /^ {0,3}(`{3,}|~{3,})[\t ]*mermaid(?:[\t ].*)?\r?\n/u.exec(raw);
	if (!opening) { return false; }
	const body = raw.slice(opening[0].length).trimEnd();
	const lastLine = body.slice(body.lastIndexOf('\n') + 1);
	return new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}$`, 'u').test(lastLine);
}

/** Presents an inert image produced by the native Markdown capability. The code card remains the source view. */
export class ChatMermaidRenderer extends Disposable {
	private snapshot: Promise<ExtensionHostFleetSnapshot> | undefined;
	private readonly diagrams = new Map<string, Blob>();

	constructor(
		@IExtensionHostApi private readonly host: IExtensionHostApi,
		@IThemeService private readonly themes: IThemeService,
	) {
		super();
		const changed = host.onDidChange(() => { this.snapshot = undefined; });
		this._register(toDisposable(() => changed.dispose()));
		const connection = host.onConnectionState(() => { this.snapshot = undefined; this.diagrams.clear(); });
		this._register(toDisposable(() => connection.dispose()));
	}

	public render(source: string, code: HTMLElement, lifetime: DisposableStore, onImageReady: (image: HTMLImageElement, lifetime: DisposableStore) => void): HTMLElement {
		const document = code.ownerDocument;
		const ownerWindow = document.defaultView;
		if (!ownerWindow || new TextEncoder().encode(source).byteLength > sourceLimit) { return code; }

		const wrapper = h(document, 'div', { className: 'ash-chat-mermaid' });
		const details = h(document, 'details');
		const summary = h(document, 'summary');
		summary.hidden = true;
		summary.textContent = localize('chat.mermaid.source', 'Mermaid source');
		details.open = true;
		details.append(summary, code);
		wrapper.append(details);
		const current = lifetime.add(new MutableDisposable<DisposableStore>());
		const preview = lifetime.add(new MutableDisposable<DisposableStore>());
		const update = (): void => {
			const run = current.value = new DisposableStore();
			const controller = new AbortController();
			run.add(toDisposable(() => controller.abort()));
			const theme = isDarkColorScheme(this.themes.getColorTheme().colorScheme) ? 'dark' : 'light';
			void this.readDiagram(source, theme, controller.signal).then(blob => {
				if (!blob || run.isDisposed) { return; }
				const objectUrl = createObjectUrl(ownerWindow, blob);
				const candidate = run.add(new DisposableStore());
				candidate.add(objectUrl.registration);
				const image = h(document, 'img');
				image.alt = localize('chat.mermaid.diagram', 'Mermaid diagram');
				candidate.add(addDisposableListener(image, 'load', () => {
					if (!preview.value) {
						const selection = document.getSelection();
						details.open = code.contains(document.activeElement) || code.contains(selection?.anchorNode ?? null) || code.contains(selection?.focusNode ?? null);
					}
					run.delete(candidate);
					preview.value = candidate;
					wrapper.prepend(image);
					onImageReady(image, candidate);
					summary.hidden = false;
				}));
				candidate.add(addDisposableListener(image, 'error', () => {
					if (run.delete(candidate)) { candidate.dispose(); }
				}));
				candidate.add(toDisposable(() => image.remove()));
				// SVG image mode cannot run scripts, follow diagram links or fetch external assets.
				image.src = objectUrl.url.toString();
			}).catch(() => { /* The original code stays available if the capability cannot render it. */ });
		};
		lifetime.add(this.themes.onDidColorThemeChange(update));
		update();
		return wrapper;
	}

	private async readDiagram(source: string, theme: 'light' | 'dark', signal: AbortSignal): Promise<Blob | undefined> {
		const pending = this.snapshot ??= this.host.list().then(snapshot => {
			const runtime = snapshot.extensions.find(extension => extension.id === extensionId);
			return runtime?.lifecycle === 'dormant' && !this.isDisposed ? this.host.activateByEvent({
				extensionId, activationGeneration: runtime.activationGeneration, event: { type: 'capability', capability: channel },
			}) : snapshot;
		});
		let snapshot: ExtensionHostFleetSnapshot;
		try { snapshot = await pending; }
		catch (error) {
			if (this.snapshot === pending) { this.snapshot = undefined; }
			throw error;
		}
		signal.throwIfAborted();
		const runtime = snapshot.extensions.find(extension => extension.id === extensionId && extension.lifecycle === 'ready');
		const registration = runtime?.registrations.find(entry => entry.kind === 'dataChannel' && entry.channelId === channel);
		if (runtime?.incarnation === undefined || !registration) { return undefined; }
		const key = JSON.stringify([runtime.activationGeneration, runtime.incarnation, theme, source]);
		const cached = this.diagrams.get(key);
		if (cached) { return cached; }
		const value = await this.host.invoke({
			extensionId, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation,
			registrationId: registration.registrationId, operation: 'receiveData', payload: { source, theme }, deadlineUnixMillis: Date.now() + 5_000,
		}, signal);
		signal.throwIfAborted();
		if (!isRecord(value) || typeof value.svg !== 'string' || !value.svg.startsWith('<svg') || new TextEncoder().encode(value.svg).byteLength > outputLimit) { return undefined; }
		const blob = new Blob([value.svg], { type: 'image/svg+xml' });
		if (this.diagrams.size >= 8) { this.diagrams.delete(this.diagrams.keys().next().value!); }
		this.diagrams.set(key, blob);
		return blob;
	}
}
