import { alert, setARIAContainer, status } from "../../../base/browser/ui/aria/aria.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { IContextKey } from "../../contextkey/common/contextkey.js";
import { IContextKeyService } from "../../contextkey/browser/contextKeyService.js";
import { IConfigurationService } from "../../configuration/common/configuration.js";
import { AccessibilityConfiguration, AccessibilitySupport, CONTEXT_ACCESSIBILITY_MODE_ENABLED, IAccessibilityService, type AccessibilityReductionConfiguration, type AccessibilitySupportConfiguration } from "../common/accessibility.js";

/** Inputs required by the browser-independent accessibility policy. */
export interface AccessibilityServiceOptions {
	readonly root: HTMLElement;
	readonly contextKeyService: IContextKeyService;
	readonly configurationService: IConfigurationService;
	readonly initialAccessibilitySupport?: AccessibilitySupport;
}

/** Applies accessibility policy, reduced-motion state, and live announcements to one Workbench. */
export class AccessibilityService extends Disposable implements IAccessibilityService {
	private readonly accessibilityModeEnabledContext: IContextKey<boolean>;
	private readonly root: HTMLElement;
	private readonly configurationService: IConfigurationService;
	private readonly onDidChangeScreenReaderOptimizedEmitter = this._register(new Emitter<void>());
	private readonly onDidChangeReducedMotionEmitter = this._register(new Emitter<void>());
	private readonly onDidChangeReducedTransparencyEmitter = this._register(new Emitter<void>());
	private readonly onDidChangeLinkUnderlinesEmitter = this._register(new Emitter<void>());
	private accessibilitySupport: AccessibilitySupport;
	private configMotionReduced: AccessibilityReductionConfiguration;
	private configTransparencyReduced: AccessibilityReductionConfiguration;
	private systemMotionReduced: boolean;
	private systemTransparencyReduced: boolean;
	private linkUnderlinesEnabled: boolean;

	readonly onDidChangeScreenReaderOptimized = this.onDidChangeScreenReaderOptimizedEmitter.event;
	readonly onDidChangeReducedMotion = this.onDidChangeReducedMotionEmitter.event;
	readonly onDidChangeReducedTransparency = this.onDidChangeReducedTransparencyEmitter.event;
	readonly onDidChangeLinkUnderlines = this.onDidChangeLinkUnderlinesEmitter.event;

	constructor(options: AccessibilityServiceOptions) {
		super();
		const ownerDocument = options.root.ownerDocument;
		this.root = options.root;
		this.configurationService = options.configurationService;
		this.accessibilitySupport = options.initialAccessibilitySupport ?? AccessibilitySupport.Unknown;
		this.configMotionReduced = options.configurationService.getValue<AccessibilityReductionConfiguration>(AccessibilityConfiguration.reduceMotion);
		this.configTransparencyReduced = options.configurationService.getValue<AccessibilityReductionConfiguration>(AccessibilityConfiguration.reduceTransparency);
		this.linkUnderlinesEnabled = options.configurationService.getValue<boolean>(AccessibilityConfiguration.underlineLinks);
		this.systemMotionReduced = false;
		this.systemTransparencyReduced = false;
		this.accessibilityModeEnabledContext = CONTEXT_ACCESSIBILITY_MODE_ENABLED.bindTo(options.contextKeyService);
		setARIAContainer(options.root);
		this._register(toDisposable(() => {
			this.accessibilityModeEnabledContext.reset();
			this.root.classList.remove("ash-reduce-motion", "ash-enable-motion", "ash-reduce-transparency", "ash-underline-links");
		}));

		const ownerWindow = ownerDocument.defaultView;
		const motionMatcher = createMediaMatcher(ownerWindow, "(prefers-reduced-motion: reduce)");
		const transparencyMatcher = createMediaMatcher(ownerWindow, "(prefers-reduced-transparency: reduce)");
		this.systemMotionReduced = motionMatcher?.matches ?? false;
		this.systemTransparencyReduced = transparencyMatcher?.matches ?? false;
		if (motionMatcher) {
			this._register(listenToMediaQuery(motionMatcher, () => {
				this.systemMotionReduced = motionMatcher.matches;
				if (this.configMotionReduced === "auto") this.onDidChangeReducedMotionEmitter.fire();
				this.updateMotionClasses();
			}));
		}
		if (transparencyMatcher) {
			this._register(listenToMediaQuery(transparencyMatcher, () => {
				this.systemTransparencyReduced = transparencyMatcher.matches;
				if (this.configTransparencyReduced === "auto") this.onDidChangeReducedTransparencyEmitter.fire();
				this.updateTransparencyClass();
			}));
		}

		this._register(options.configurationService.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(AccessibilityConfiguration.editorAccessibilitySupport)) {
				this.updateAccessibilityModeContext();
				this.onDidChangeScreenReaderOptimizedEmitter.fire();
			}
			if (event.affectsConfiguration(AccessibilityConfiguration.reduceMotion)) {
				this.configMotionReduced = options.configurationService.getValue<AccessibilityReductionConfiguration>(AccessibilityConfiguration.reduceMotion);
				this.updateMotionClasses();
				this.onDidChangeReducedMotionEmitter.fire();
			}
			if (event.affectsConfiguration(AccessibilityConfiguration.reduceTransparency)) {
				this.configTransparencyReduced = options.configurationService.getValue<AccessibilityReductionConfiguration>(AccessibilityConfiguration.reduceTransparency);
				this.updateTransparencyClass();
				this.onDidChangeReducedTransparencyEmitter.fire();
			}
			if (event.affectsConfiguration(AccessibilityConfiguration.underlineLinks)) {
				this.linkUnderlinesEnabled = options.configurationService.getValue<boolean>(AccessibilityConfiguration.underlineLinks);
				this.updateLinkUnderlineClass();
				this.onDidChangeLinkUnderlinesEmitter.fire();
			}
		}));

		this.updateAccessibilityModeContext();
		this.updateMotionClasses();
		this.updateTransparencyClass();
		this.updateLinkUnderlineClass();
	}

	alwaysUnderlineAccessKeys(): Promise<boolean> {
		return Promise.resolve(false);
	}

	isScreenReaderOptimized(): boolean {
		const configured = this.configurationService.getValue<AccessibilitySupportConfiguration>(AccessibilityConfiguration.editorAccessibilitySupport);
		return configured === "on" || (configured === "auto" && this.accessibilitySupport === AccessibilitySupport.Enabled);
	}

	isMotionReduced(): boolean {
		return this.configMotionReduced === "on" || (this.configMotionReduced === "auto" && this.systemMotionReduced);
	}

	isTransparencyReduced(): boolean {
		return this.configTransparencyReduced === "on" || (this.configTransparencyReduced === "auto" && this.systemTransparencyReduced);
	}

	getAccessibilitySupport(): AccessibilitySupport {
		return this.accessibilitySupport;
	}

	setAccessibilitySupport(accessibilitySupport: AccessibilitySupport): void {
		if (!isAccessibilitySupport(accessibilitySupport) || this.accessibilitySupport === accessibilitySupport) return;
		this.accessibilitySupport = accessibilitySupport;
		this.updateAccessibilityModeContext();
		this.onDidChangeScreenReaderOptimizedEmitter.fire();
	}

	alert(message: string): void {
		alert(message);
	}

	status(message: string): void {
		status(message);
	}

	private updateAccessibilityModeContext(): void {
		this.accessibilityModeEnabledContext.set(this.isScreenReaderOptimized());
	}

	private updateMotionClasses(): void {
		const reduced = this.isMotionReduced();
		this.root.classList.toggle("ash-reduce-motion", reduced);
		this.root.classList.toggle("ash-enable-motion", !reduced);
	}

	private updateTransparencyClass(): void {
		this.root.classList.toggle("ash-reduce-transparency", this.isTransparencyReduced());
	}

	private updateLinkUnderlineClass(): void {
		this.root.classList.toggle("ash-underline-links", this.linkUnderlinesEnabled);
	}
}

function isAccessibilitySupport(value: AccessibilitySupport): boolean {
	return value === AccessibilitySupport.Unknown || value === AccessibilitySupport.Disabled || value === AccessibilitySupport.Enabled;
}

function createMediaMatcher(ownerWindow: Window | null, query: string): MediaQueryList | undefined {
	return ownerWindow?.matchMedia?.(query);
}

function listenToMediaQuery(matcher: MediaQueryList, listener: () => void) {
	const eventListener = () => listener();
	const legacyMatcher = matcher as MediaQueryList & { addListener?: (listener: (event: MediaQueryListEvent) => void) => void; removeListener?: (listener: (event: MediaQueryListEvent) => void) => void };
	if (typeof matcher.addEventListener === "function") {
		matcher.addEventListener("change", eventListener);
		return toDisposable(() => matcher.removeEventListener("change", eventListener));
	}
	legacyMatcher.addListener?.(eventListener);
	return toDisposable(() => legacyMatcher.removeListener?.(eventListener));
}
