import '../../../base/browser/ui/hover/hover.css';
import type { HoverDelegateSetupOptions, IHoverDelegate, IManagedHover as IBaseManagedHover } from '../../../base/browser/ui/hover/hoverDelegate.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { Hover, type HoverContent, type IDelayedHoverOptions, type IHoverLifecycleOptions } from '../../../base/browser/ui/hover/hover.js';
import { addDisposableListener, getActiveElement, isHTMLElement } from '../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { ContextView, type IContextViewProvider } from '../../../base/browser/ui/contextview/contextview.js';
import { observeResize } from '../../../base/browser/observer.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import type { IContextMenuService } from '../../contextview/browser/contextView.js';
import type { IContextViewService } from '../../contextview/browser/contextView.js';
import { HoverConfiguration, type HoverDelayMode } from '../common/hoverService.js';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../actions/common/actions.js';
import type { ServicesAccessor } from '../../instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';

/** Caller-owned description of one target and its managed Hover content. */
export interface HoverSetupOptions extends HoverDelegateSetupOptions {
	readonly delay?: HoverDelayMode;
	readonly setupKeyboardEvents?: boolean;
}

/** Handle returned to callers for updating or explicitly controlling a Hover. */
export type IManagedHover = IBaseManagedHover;

/**
 * Coordinates managed Hovers inside one Workbench window.
 *
 * Implementations own product delay policy and global overlay coordination;
 * callers retain ownership of the returned managed Hover handles.
 */
export interface IHoverService extends IHoverDelegate {
	setupHover(options: HoverSetupOptions): IManagedHover;
	showHover(options: HoverSetupOptions): IManagedHover;
	/** Shows and focuses the registration on the target or its nearest registered ancestor. */
	showManagedHover(target: HTMLElement): void;
	/** Restores the last live chain, skipping disposed registrations and disconnected targets. */
	showAndFocusLastHover(): void;
	hideHover(): void;
}

export const IHoverService = createServiceIdentifier<IHoverService>('hoverService');

const InstantHoverWindowMs = 200;
const PointerHoverResumeDistance = 2;
let nextHoverServiceId = 0;

/** Browser implementation of the window-scoped Workbench Hover policy. */
export class HoverService extends Disposable implements IHoverService {
	private readonly managedHovers = new Set<ManagedHover>();
	private readonly configurationService: IConfigurationService;
	private readonly contextViewService: IContextViewService;
	private activeHover: ManagedHover | undefined;
	private lastHoverPath: readonly ManagedHover[] = [];
	private contextMenuVisible = false;
	private pointerHoverSuppressed = false;
	private pointerActivationPosition: { readonly x: number; readonly y: number; } | undefined;
	private lastGroupId: string | undefined;
	private lastHideTime = 0;

	constructor(configurationService: IConfigurationService, contextViewService: IContextViewService, contextMenuService: IContextMenuService) {
		super();
		this.configurationService = configurationService;
		this.contextViewService = contextViewService;
		const ownerDocument = contextViewService.container.ownerDocument;
		this._register(addDisposableListener(ownerDocument, 'pointerdown', (event) => {
			if (isHTMLElement(event.target) && event.target.closest('.ash-hover')) return;
			this.pointerHoverSuppressed = true;
			this.pointerActivationPosition = { x: event.clientX, y: event.clientY };
			this.hideAllHovers();
			this.lastGroupId = undefined;
			this.lastHideTime = 0;
		}, true));
		this._register(addDisposableListener(ownerDocument, 'pointermove', (event) => {
			const activationPosition = this.pointerActivationPosition;
			if (event.buttons !== 0 || !activationPosition) return;
			const deltaX = event.clientX - activationPosition.x;
			const deltaY = event.clientY - activationPosition.y;
			if (deltaX * deltaX + deltaY * deltaY <= PointerHoverResumeDistance * PointerHoverResumeDistance) return;
			this.pointerHoverSuppressed = false;
			this.pointerActivationPosition = undefined;
		}, true));
		this._register(contextMenuService.onDidShowContextMenu(() => {
			this.contextMenuVisible = true;
			this.hideAllHovers();
		}));
		this._register(contextMenuService.onDidHideContextMenu(() => {
			this.contextMenuVisible = false;
		}));
		this._register(toDisposable(() => {
			for (const hover of [...this.managedHovers]) hover.dispose();
		}));
		const serviceId = nextHoverServiceId++;
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type,
				priority: 95,
				name: `hover-${serviceId}-${type}`,
				getProvider: accessor => {
					if (accessor.get(IHoverService) !== this || !this.activeHover?.domNode) {
						return undefined;
					}
					if (type === AccessibleViewType.Help &&
						!this.activeHover.domNode.contains(getActiveElement(this.activeHover.target.ownerDocument))) {
						return undefined;
					}
					const text = this.activeHover.domNode.textContent ?? '';
					if (!text.trim()) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Hover, { type }, () => type === AccessibleViewType.View
						? text
						: localize('hover.accessibilityHelp', 'Hover\nUse <keybinding:workbench.action.showHover> to show or focus the hint for the focused control. Tab and Shift+Tab move between actions. Escape closes the current hint and returns focus. Hold Alt or Option while moving the pointer to keep a hint open. Use <keybinding:editor.action.accessibleView> to read its content.'),
						() => this.showAndFocusLastHover(), AccessibilityVerbositySettingId.Hover);
				},
			}));
		}
	}

	setupHover(options: HoverSetupOptions): IManagedHover {
		return this.createManagedHover(options);
	}

	public setupDelayedHover(target: HTMLElement, hoverOptions: (() => IDelayedHoverOptions) | IDelayedHoverOptions, lifecycleOptions?: IHoverLifecycleOptions): IDisposable {
		return this.createManagedHover({
			target,
			content: undefined,
			groupId: lifecycleOptions?.groupId,
			delay: lifecycleOptions?.reducedDelay ? 'reduced' : undefined,
			setupKeyboardEvents: lifecycleOptions?.setupKeyboardEvents,
		}, typeof hoverOptions === 'function' ? hoverOptions : () => hoverOptions);
	}

	private createManagedHover(options: HoverSetupOptions, getHoverOptions?: () => IDelayedHoverOptions): IManagedHover {
		let managed!: ManagedHover;
		const viewLifetime = new DisposableStore();
		const nestedView = viewLifetime.add(new MutableDisposable<ContextView>());
		const nestedLayout = viewLifetime.add(new MutableDisposable<IDisposable>());
		const provider: IContextViewProvider = {
			show: viewOptions => {
				const parent = this.findContainingHover(options.target, managed);
				managed.parent = parent;
				if (!parent) { return this.contextViewService.show(viewOptions); }
				for (const hover of this.managedHovers) {
					if (hover !== managed && hover.parent === parent) { hover.hide(); }
				}
				const container = parent.domNode!.parentElement!;
				nestedView.value = new ContextView(container.parentElement!);
				// Changing card height can move the child anchor without changing the anchor's size.
				nestedLayout.value = observeResize(parent.domNode!, () => nestedView.value?.layout());
				let layer = 1;
				for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) { layer++; }
				return nestedView.value.show({ ...viewOptions, layer });
			},
			hide: () => nestedView.value ? nestedView.value.hide() : this.contextViewService.hide(),
			layout: () => nestedView.value ? nestedView.value.layout() : this.contextViewService.layout(),
		};
		managed = new ManagedHover({
			viewLifetime,
			hover: new Hover({
				target: options.target,
				content: options.content,
				getHoverOptions,
				delayMs: () => this.resolveDelay(options.delay, options.groupId),
				persistence: options.persistence,
				enabled: () => !this.contextMenuVisible,
				pointerHoverEnabled: () => !this.pointerHoverSuppressed,
				anchorAlignment: options.anchorAlignment,
				anchorAxisAlignment: options.anchorAxisAlignment,
				anchorPosition: options.anchorPosition,
				gap: options.gap,
				contextViewProvider: provider,
				isTargetWithin: target => this.containsDescendant(managed, target),
				setupKeyboardEvents: options.setupKeyboardEvents,
				trapFocus: options.trapFocus,
			}),
			groupId: options.groupId,
			onDidShow: () => this.didShow(managed),
			onDidHide: () => {
				nestedLayout.clear();
				nestedView.clear();
				this.didHide(managed);
				options.onDidHide?.();
			},
			onDispose: () => this.release(managed),
		});
		this.managedHovers.add(managed);
		return managed;
	}

	private findContainingHover(target: HTMLElement, current: ManagedHover): ManagedHover | undefined {
		let parent: ManagedHover | undefined;
		for (const hover of this.managedHovers) {
			if (hover !== current && hover.visible && hover.domNode?.contains(target) &&
				(!parent || parent.domNode?.contains(hover.domNode))) {
				parent = hover;
			}
		}
		return parent;
	}

	private containsDescendant(parent: ManagedHover, target: Node): boolean {
		for (const hover of this.managedHovers) {
			if (!hover.visible || !hover.domNode?.contains(target)) { continue; }
			for (let ancestor = hover.parent; ancestor; ancestor = ancestor.parent) {
				if (ancestor === parent) { return true; }
			}
		}
		return false;
	}

	showHover(options: HoverSetupOptions): IManagedHover {
		const hover = this.setupHover({ ...options, delay: 'instant' });
		hover.show();
		return hover;
	}

	showManagedHover(target: HTMLElement): void {
		for (let element: HTMLElement | null = target; element; element = element.parentElement) {
			for (const hover of this.managedHovers) {
				if (hover.target !== element) { continue; }
				hover.show(true);
				return;
			}
		}
	}

	showAndFocusLastHover(): void {
		// Restore ancestors first: their content owns the targets of nested hints.
		const path = this.lastHoverPath;
		let lastShown: ManagedHover | undefined;
		for (const hover of path) {
			if (!this.managedHovers.has(hover) || !hover.target.isConnected) { continue; }
			hover.show();
			if (hover.visible) { lastShown = hover; }
		}
		lastShown?.show(true);
	}

	hideHover(): void {
		// Registrations can be waiting without an active view. Dismissal cancels those timers too.
		for (const hover of this.managedHovers) {
			if (!hover.visible) { hover.hide(); }
		}
		this.activeHover?.hide();
	}

	private hideAllHovers(): void {
		for (const hover of this.managedHovers) { hover.hide(); }
	}

	private resolveDelay(mode: HoverDelayMode | undefined, groupId: string | undefined): number {
		if (mode === 'instant' || this.shouldSkipDelay(groupId)) return 0;
		return this.configurationService.getValue<number>(
			mode === 'reduced'
				? HoverConfiguration.reducedDelay
				: HoverConfiguration.delay,
		);
	}

	private shouldSkipDelay(groupId: string | undefined): boolean {
		if (groupId === undefined) return false;
		if (this.activeHover?.groupId === groupId) return true;
		return this.lastGroupId === groupId &&
			Date.now() - this.lastHideTime <= InstantHoverWindowMs;
	}

	private didShow(hover: ManagedHover): void {
		this.activeHover = hover;
		const path = [hover];
		for (let ancestor = hover.parent; ancestor; ancestor = ancestor.parent) { path.unshift(ancestor); }
		this.lastHoverPath = path;
	}

	private didHide(hover: ManagedHover): void {
		for (const child of this.managedHovers) {
			if (child.parent === hover) { child.hide(); }
		}
		if (this.activeHover === hover) { this.activeHover = hover.parent?.visible ? hover.parent : undefined; }
		if (!this.activeHover) {
			this.lastGroupId = hover.groupId;
			this.lastHideTime = Date.now();
		}
		hover.parent = undefined;
	}

	private release(hover: ManagedHover): void {
		this.managedHovers.delete(hover);
		this.lastHoverPath = this.lastHoverPath.filter(entry => entry !== hover);
		this.didHide(hover);
	}
}

registerAction2(class ShowHoverAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.showHover',
			title: localize2('hover.show', 'Show or focus hover'),
			f1: true,
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyI),
				weight: KeybindingWeight.EditorCore,
			},
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const target = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument);
		if (isHTMLElement(target)) { accessor.get(IHoverService).showManagedHover(target); }
	}
});

interface ManagedHoverOptions {
	readonly hover: Hover;
	readonly viewLifetime: DisposableStore;
	readonly groupId?: string;
	readonly onDidShow: () => void;
	readonly onDidHide: () => void;
	readonly onDispose: () => void;
}

class ManagedHover extends Disposable implements IManagedHover {
	readonly groupId: string | undefined;
	public parent: ManagedHover | undefined;
	private readonly hover: Hover;

	constructor(options: ManagedHoverOptions) {
		super();
		this.groupId = options.groupId;
		this._register(options.viewLifetime);
		this.hover = this._register(options.hover);
		this._register(this.hover.onDidShow(options.onDidShow));
		this._register(this.hover.onDidHide(options.onDidHide));
		this._register(toDisposable(options.onDispose));
	}

	get visible(): boolean {
		return this.hover.visible;
	}

	get domNode(): HTMLElement | undefined {
		return this.hover.domNode;
	}

	get target(): HTMLElement {
		return this.hover.element;
	}

	protected override disposeCore(): void {
		this.hover.hide();
		super.disposeCore();
	}

	show(focus?: boolean): void {
		this.hover.show(focus);
	}

	hide(): void {
		this.hover.hide();
	}

	update(content: HoverContent): void {
		this.hover.update(content);
	}
}
