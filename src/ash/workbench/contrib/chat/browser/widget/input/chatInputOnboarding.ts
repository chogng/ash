import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { pickActiveChatInput, trackChatInputRecency, type IChatInputNoticeClaimOptions, type IChatInputNoticeFocusTarget, type IChatInputSurface } from './chatInputNoticeHost.js';
import { ChatInputStackSlot, setChatInputStackSlot } from './chatInputStack.js';

export type ChatInputNoticeClaim = (options: IChatInputNoticeClaimOptions) => IDisposable;

/** Registration lifetime follows the host's visibility; disposing releases its banner. */
export interface IChatInputOnboardingHostOptions {
	readonly container: HTMLElement;
	readonly focusRoot: HTMLElement;
	readonly focus?: () => void;
	readonly claimNotice?: ChatInputNoticeClaim;
}

export interface IChatInputOnboardingContext {
	readonly container: HTMLElement;
	readonly dismiss: (restoreFocus?: boolean) => void;
	readonly acknowledge: () => void;
	readonly focusInput?: () => void;
}

export interface IChatInputOnboardingBanner extends IDisposable, IChatInputNoticeFocusTarget {
	announce(): void;
	/** Hide the banner while another notice leads; the same card may become visible again. */
	setVisible?(visible: boolean): void;
}

type OnboardingFactory = (context: IChatInputOnboardingContext) => IChatInputOnboardingBanner;
type OnboardingHost = IChatInputOnboardingHostOptions & IChatInputSurface;

interface OnboardingRequest {
	readonly host: OnboardingHost;
	readonly create: OnboardingFactory;
	claim?: IDisposable;
	banner?: IChatInputOnboardingBanner;
	leading: boolean;
	shown: boolean;
}

/** Owns host selection and introduction persistence; the feature only builds its card. */
export class ChatInputOnboarding extends Disposable {
	private readonly hosts = new Set<OnboardingHost>();
	private readonly registrations = this._register(new DisposableMap<OnboardingHost>());
	private request: OnboardingRequest | undefined;

	constructor(
		private readonly storageKey: string,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
	}

	registerHost(options: IChatInputOnboardingHostOptions): IDisposable {
		const host = { ...options, lastFocused: 0 };
		this.hosts.add(host);
		const registration = new DisposableStore();
		registration.add(trackChatInputRecency(host));
		registration.add(toDisposable(() => {
			this.hosts.delete(host);
			if (this.request?.host === host) this.close(false);
		}));
		this.registrations.set(host, registration);
		return toDisposable(() => this.registrations.deleteAndDispose(host));
	}

	showIfNeeded(createOnboarding: OnboardingFactory): boolean {
		if (this.request) {
			// An unacknowledged introduction follows a new first-use request to its
			// active surface, including a floating voice window in another document.
			const host = pickActiveChatInput(this.hosts);
			if (host && host !== this.request.host) return this.show(createOnboarding);
			return true;
		}
		if (this.storage.getBoolean(this.storageKey, StorageScope.PROFILE, false)) return false;
		return this.show(createOnboarding);
	}

	show(createOnboarding: OnboardingFactory): boolean {
		if (this.isDisposed) return false;
		const host = pickActiveChatInput(this.hosts);
		if (!host) return false;
		const previous = this.request;
		const request: OnboardingRequest = { host, create: createOnboarding, leading: false, shown: false };
		this.request = request;
		// Retire the old card before taking the new claim, but keep its lane occupied
		// until the replacement is registered so a lower-priority tip never flashes.
		if (previous) setChatInputStackSlot(previous.host.container, ChatInputStackSlot.Empty);
		previous?.banner?.dispose();
		try {
			if (host.claimNotice) {
				const claim = host.claimNotice({
					focusTarget: {
						hasFocus: () => request.banner?.hasFocus() ?? false,
						focus: () => request.banner?.focus(),
						canFocus: () => request.leading && !!request.banner && (request.banner.canFocus?.() ?? true),
					},
					onDidChangeLeading: leading => this.setLeading(request, leading),
				});
				if (this.request === request) request.claim = claim;
				else claim.dispose();
			} else {
				this.setLeading(request, true);
			}
		} finally {
			previous?.claim?.dispose();
		}
		return true;
	}

	private setLeading(request: OnboardingRequest, leading: boolean): void {
		if (this.request !== request || this.isDisposed || request.leading === leading) return;
		request.leading = leading;
		if (!leading) {
			setChatInputStackSlot(request.host.container, ChatInputStackSlot.Empty);
			request.banner?.setVisible?.(false);
			return;
		}
		// Card construction can focus its first action, so reveal the host before invoking the feature.
		setChatInputStackSlot(request.host.container, ChatInputStackSlot.Standalone);
		if (!request.banner) {
			try {
				const banner = request.create({
					container: request.host.container,
					focusInput: request.host.focus,
					acknowledge: () => {
						if (this.request !== request || !request.leading || !request.shown) return;
						this.storage.store(this.storageKey, true, StorageScope.PROFILE, StorageTarget.USER);
						this.close(true);
					},
					dismiss: (restoreFocus = true) => {
						if (this.request === request) this.close(restoreFocus);
					}
				});
				if (this.request !== request || this.isDisposed) {
					banner.dispose();
					return;
				}
				request.banner = banner;
			} catch (error) {
				if (this.request === request) this.close(false);
				throw error;
			}
		}
		request.banner.setVisible?.(request.leading);
		if (this.request !== request || !request.leading) return;
		if (request.leading && !request.shown) {
			request.shown = true;
			request.banner.announce();
		}
	}

	private close(restoreFocus: boolean): void {
		const request = this.request;
		if (!request) return;
		this.request = undefined;
		const hadFocus = request.banner?.hasFocus() ?? false;
		setChatInputStackSlot(request.host.container, ChatInputStackSlot.Empty);
		request.banner?.dispose();
		request.claim?.dispose();
		if (restoreFocus && hadFocus) request.host.focus?.();
	}

	protected override disposeCore(): void {
		this.close(false);
		this.hosts.clear();
		super.disposeCore();
	}
}
