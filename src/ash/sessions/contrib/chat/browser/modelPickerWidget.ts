import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { isReducedMotion } from '../../../../base/browser/ui/animations/animations.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import '../../../common/theme.js';
import './media/modelPickerWidget.css';

/** Provider-owned values and actions. Unknown thinking capabilities are omitted. */
export interface ModelPickerPresentation {
	readonly models: readonly { readonly id: string; readonly title: string; }[];
	readonly selectedModel: string;
	readonly disabled: boolean;
	readonly thinking?: {
		readonly levels: readonly { readonly id: string; readonly label: string; }[];
		readonly selectedLevel: string;
		/** A distinct provider mode; neither the label nor the final stop implies emphasis. */
		readonly emphasized?: boolean;
		select(level: string): void;
	};
}

/** Sessions' compact model control. Owns transient UI; selections belong to its host. */
export class ModelPickerWidget extends Disposable {
	private readonly button: HTMLButtonElement;
	private readonly label: HTMLElement;
	private readonly popupResources = this._register(new DisposableStore());
	private presentation: ModelPickerPresentation = { models: [], selectedModel: '', disabled: true };
	private popup: HTMLElement | undefined;
	private refreshPopup: (() => void) | undefined;

	constructor(
		container: HTMLElement,
		private readonly selectModel: (model: string) => void,
		@IContextViewService private readonly views: IContextViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.button = h(container.ownerDocument, 'button');
		this.button.type = 'button';
		this.button.className = 'ash-sessions-model-picker';
		this.button.setAttribute('aria-expanded', 'false');
		this.label = h(container.ownerDocument, 'span');
		this.label.className = 'ash-sessions-model-picker-label';
		this.button.append(this.label);
		appendIcon(Lxicon.chevronDown, this.button);
		container.append(this.button);
		this._register(addDisposableListener(this.button, 'pointerdown', event => {
			// Preserve the open popup until click toggles it; moving focus first would
			// dismiss it on focusout and immediately reopen it on the same click.
			if (this.popup) { event.preventDefault(); }
		}));
		this._register(addDisposableListener(this.button, 'click', event => this.popup ? this.hide() : this.show(event.detail === 0)));
		this._register(addDisposableListener(this.button, 'keydown', event => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				this.show(true);
			}
		}));
		this._register(toDisposable(() => { this.hide(); this.button.remove(); }));
		this.update(this.presentation);
	}

	public update(presentation: ModelPickerPresentation): void {
		const previous = this.presentation;
		this.presentation = presentation;
		const model = presentation.models.find(model => model.id === presentation.selectedModel);
		const thinking = this.thinking;
		const level = thinking?.levels.find(level => level.id === thinking.selectedLevel);
		const modelLabel = localize('sessions.modelPicker.chooseModel', 'Choose model: {0}', model?.title ?? localize('sessions.modelPicker.model', 'Model'));
		this.label.textContent = level?.label ?? model?.title ?? localize('sessions.modelPicker.model', 'Model');
		this.button.title = thinking ? localize('sessions.modelPicker.modelAndThinking', '{0} · {1}', model?.title ?? '', this.label.textContent) : modelLabel;
		this.button.setAttribute('aria-label', thinking ? localize('sessions.modelPicker.chooseThinking', 'Thinking level: {0}. Model: {1}', this.label.textContent, model?.title ?? '') : modelLabel);
		this.button.setAttribute('aria-haspopup', this.popup?.getAttribute('role') ?? (thinking ? 'dialog' : 'menu'));
		this.button.disabled = presentation.disabled || !presentation.models.length;
		if (this.button.disabled || previous.models !== presentation.models) {
			this.hide();
		} else {
			this.refreshPopup?.();
		}
	}

	public hide(): void {
		if (this.popup) { this.views.hide(); }
	}

	private get thinking(): ModelPickerPresentation['thinking'] {
		const thinking = this.presentation.thinking;
		return thinking && thinking.levels.length > 0 && thinking.levels.some(level => level.id === thinking.selectedLevel) ? thinking : undefined;
	}

	private show(keyboard: boolean): void {
		if (this.button.disabled || this.popup) { return; }
		this.button.focus();
		const popup = h(this.button.ownerDocument, 'div');
		popup.id = `sessions-model-picker-${createUuid()}`;
		popup.className = 'ash-sessions-model-picker-popup';
		popup.dataset.reducedMotion = String(isReducedMotion(this.button));
		popup.tabIndex = -1;
		this.popup = popup;
		this.button.setAttribute('aria-controls', popup.id);
		this.button.setAttribute('aria-expanded', 'true');
		this.registerAccessibility(popup);
		const surface = h(popup.ownerDocument, 'div');
		surface.className = 'ash-sessions-model-picker-surface';
		const pages = h(popup.ownerDocument, 'div');
		pages.className = 'ash-sessions-model-picker-pages';
		const thinkingPage = h(popup.ownerDocument, 'div');
		const modelsPage = h(popup.ownerDocument, 'div');
		thinkingPage.className = modelsPage.className = 'ash-sessions-model-picker-page';
		pages.append(thinkingPage, modelsPage);
		surface.append(pages);
		popup.append(surface);
		let view: 'thinking' | 'models' = this.thinking ? 'thinking' : 'models';
		const setView = (next: typeof view, focus: boolean): void => {
			// Keep both pages mounted: selection changes update their existing controls,
			// and an interrupted transition can continue from its current visual state.
			if (popup.isConnected) { popup.focus({ preventScroll: true }); }
			view = next;
			popup.dataset.view = next;
			popup.setAttribute('role', next === 'thinking' ? 'dialog' : 'menu');
			popup.setAttribute('aria-label', next === 'thinking' ? localize('sessions.modelPicker.thinking', 'Thinking level') : localize('sessions.modelPicker.models', 'Choose model'));
			this.button.setAttribute('aria-haspopup', popup.getAttribute('role')!);
			thinkingPage.inert = next !== 'thinking';
			modelsPage.inert = next !== 'models';
			thinkingPage.setAttribute('aria-hidden', String(thinkingPage.inert));
			modelsPage.setAttribute('aria-hidden', String(modelsPage.inert));
			thinkingPage.dataset.active = String(!thinkingPage.inert);
			modelsPage.dataset.active = String(!modelsPage.inert);
			if (popup.isConnected) {
				pages.style.height = `${(next === 'thinking' ? thinkingPage : modelsPage).offsetHeight}px`;
				this.views.layout();
				if (focus) { (next === 'thinking' ? thinking.focus() : models.focus()).focus({ preventScroll: true }); }
			}
		};
		const thinking = this.renderThinking(thinkingPage, event => setView('models', event.detail === 0));
		const models = this.renderModels(modelsPage, (model, keyboard) => {
			this.selectModel(model);
			if (this.thinking) { setView('thinking', keyboard); }
			else { this.hide(); }
		});
		this.popupResources.add(addDisposableListener(popup, 'keydown', event => {
			if (event.target !== popup || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const controls = (view === 'thinking' ? thinkingPage : modelsPage).querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
			event.preventDefault();
			(event.key === 'ArrowUp' || event.key === 'End' ? controls[controls.length - 1] : controls[0])?.focus();
		}));
		this.refreshPopup = () => {
			thinking.refresh();
			models.refresh();
			if (!this.thinking && view === 'thinking') { setView('models', true); }
			else { pages.style.height = `${(view === 'thinking' ? thinkingPage : modelsPage).offsetHeight}px`; }
		};
		setView(view, false);
		this.closeOnFocusOut(popup);
		if (this.views.show({
			anchor: this.button, content: popup, presentation: 'plain', gap: 8,
			anchorAlignment: AnchorAlignment.Right, anchorPosition: AnchorPosition.Above,
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				this.popup = undefined;
				this.refreshPopup = undefined;
				this.button.setAttribute('aria-expanded', 'false');
				this.button.setAttribute('aria-haspopup', this.thinking ? 'dialog' : 'menu');
				this.button.removeAttribute('aria-controls');
				this.popupResources.clear();
			},
		})) { setView(view, keyboard); }
	}

	private renderThinking(popup: HTMLElement, openModels: (event: MouseEvent) => void): { focus(): HTMLElement; refresh(): void; } {
		const models = h(popup.ownerDocument, 'button');
		models.type = 'button';
		models.className = 'ash-sessions-model-picker-heading';
		models.setAttribute('aria-label', localize('sessions.modelPicker.models', 'Choose model'));
		const title = h(popup.ownerDocument, 'span');
		title.className = 'ash-sessions-model-picker-label';
		models.append(title);
		appendIcon(Lxicon.chevronRight, models);
		popup.append(models);
		this.popupResources.add(addDisposableListener(models, 'click', openModels));
		const track = h(popup.ownerDocument, 'div');
		track.className = 'ash-sessions-model-picker-track';
		const slider = h(popup.ownerDocument, 'input');
		slider.type = 'range';
		slider.min = '0';
		slider.step = '1';
		slider.setAttribute('aria-label', localize('sessions.modelPicker.thinking', 'Thinking level'));
		const fill = h(popup.ownerDocument, 'div');
		fill.className = 'ash-sessions-model-picker-fill';
		fill.setAttribute('aria-hidden', 'true');
		const effects = h(popup.ownerDocument, 'div');
		effects.className = 'ash-sessions-model-picker-maximum-effects';
		for (let index = 0; index < 12; index++) {
			const particle = h(popup.ownerDocument, 'span');
			particle.style.left = `${6 + index * 7.5}%`;
			particle.style.top = `${25 + (index * 19 % 50)}%`;
			particle.style.animationDelay = `${-index * 230}ms`;
			particle.style.animationDuration = `${1800 + (index % 5) * 270}ms`;
			effects.append(particle);
		}
		fill.append(effects);
		const ticks = h(popup.ownerDocument, 'div');
		ticks.className = 'ash-sessions-model-picker-ticks';
		ticks.setAttribute('aria-hidden', 'true');
		const rail = h(popup.ownerDocument, 'div');
		rail.className = 'ash-sessions-model-picker-thumb-rail';
		rail.setAttribute('aria-hidden', 'true');
		const thumb = h(popup.ownerDocument, 'div');
		thumb.className = 'ash-sessions-model-picker-thumb';
		rail.append(thumb);
		track.append(fill, ticks, rail, slider);
		popup.append(track);
		let renderedLevels: NonNullable<ModelPickerPresentation['thinking']>['levels'] | undefined;
		let pointer: number | undefined;
		const refresh = (): void => {
			const current = this.thinking;
			const levels = current?.levels ?? [];
			const index = levels.findIndex(level => level.id === current?.selectedLevel);
			track.dataset.emphasized = models.dataset.emphasized = String(current?.emphasized === true);
			title.textContent = levels[index]?.label ?? '';
			title.title = title.textContent;
			slider.max = String(Math.max(0, levels.length - 1));
			slider.disabled = levels.length < 2;
			track.dataset.disabled = String(slider.disabled);
			slider.value = String(Math.max(0, index));
			slider.setAttribute('aria-valuetext', title.textContent);
			if (renderedLevels !== levels) {
				renderedLevels = levels;
				ticks.replaceChildren(...levels.map(() => h(popup.ownerDocument, 'span')));
			}
			Array.from(ticks.children).forEach((tick, i) => tick.setAttribute('data-selected', String(i <= index)));
			if (pointer === undefined) { track.style.setProperty('--ash-model-picker-position', String(levels.length > 1 ? index / (levels.length - 1) : 0)); }
		};
		refresh();
		this.popupResources.add(addDisposableListener(slider, 'input', () => {
			const level = this.thinking?.levels[slider.valueAsNumber];
			if (level) { this.thinking!.select(level.id); }
		}));
		const selectAt = (clientX: number): void => {
			const current = this.thinking;
			if (!current || slider.disabled) { return; }
			const bounds = rail.getBoundingClientRect();
			const position = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
			track.style.setProperty('--ash-model-picker-position', String(position));
			const level = current.levels[Math.round(position * (current.levels.length - 1))]!;
			if (level.id !== current.selectedLevel) { current.select(level.id); }
		};
		this.popupResources.add(addDisposableListener(slider, 'pointerdown', event => {
			if (event.button !== 0 || slider.disabled) { return; }
			event.preventDefault();
			pointer = event.pointerId;
			track.dataset.dragging = 'true';
			slider.focus({ preventScroll: true });
			slider.setPointerCapture(pointer);
			selectAt(event.clientX);
		}));
		this.popupResources.add(addDisposableListener(slider, 'pointermove', event => {
			if (pointer === event.pointerId) { selectAt(event.clientX); }
		}));
		const endDrag = (event: PointerEvent): void => {
			if (pointer !== event.pointerId) { return; }
			if (event.type === 'pointerup') { selectAt(event.clientX); }
			pointer = undefined;
			track.dataset.dragging = 'false';
			if (slider.hasPointerCapture(event.pointerId)) { slider.releasePointerCapture(event.pointerId); }
			refresh();
		};
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
			this.popupResources.add(addDisposableListener(slider, type, endDrag));
		}
		this.popupResources.add(toDisposable(() => {
			if (pointer !== undefined && slider.hasPointerCapture(pointer)) { slider.releasePointerCapture(pointer); }
		}));
		this.popupResources.add(addDisposableListener(popup, 'keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { return; }
			event.preventDefault();
			(popup.ownerDocument.activeElement === models && !slider.disabled ? slider : models).focus();
		}));
		return { focus: () => models, refresh };
	}

	private renderModels(popup: HTMLElement, select: (model: string, keyboard: boolean) => void): { focus(): HTMLElement; refresh(): void; } {
		const buttons: HTMLButtonElement[] = [];
		for (const model of this.presentation.models) {
			const button = h(popup.ownerDocument, 'button');
			button.type = 'button';
			button.className = 'ash-sessions-model-picker-item';
			button.setAttribute('role', 'menuitemradio');
			const checked = model.id === this.presentation.selectedModel;
			button.setAttribute('aria-checked', String(checked));
			button.tabIndex = checked ? 0 : -1;
			button.title = model.title;
			const label = h(popup.ownerDocument, 'span');
			label.className = 'ash-sessions-model-picker-label';
			label.textContent = model.title;
			button.append(label);
			const check = appendIcon(Lxicon.check, button);
			check.style.visibility = checked ? 'visible' : 'hidden';
			popup.append(button);
			buttons.push(button);
			this.popupResources.add(addDisposableListener(button, 'click', event => select(model.id, event.detail === 0)));
		}
		this.popupResources.add(addDisposableListener(popup, 'keydown', event => {
			const index = buttons.indexOf(popup.ownerDocument.activeElement as HTMLButtonElement);
			let next: number;
			switch (event.key) {
				case 'ArrowDown': next = (index + 1) % buttons.length; break;
				case 'ArrowUp': next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length; break;
				case 'Home': next = 0; break;
				case 'End': next = buttons.length - 1; break;
				default: return;
			}
			event.preventDefault();
			buttons.forEach((button, i) => button.tabIndex = i === next ? 0 : -1);
			buttons[next]!.focus();
		}));
		return {
			focus: () => buttons.find(button => button.getAttribute('aria-checked') === 'true') ?? buttons[0]!,
			refresh: () => buttons.forEach((button, index) => {
				const checked = this.presentation.models[index]!.id === this.presentation.selectedModel;
				button.setAttribute('aria-checked', String(checked));
				button.tabIndex = checked ? 0 : -1;
				(button.lastElementChild as HTMLElement).style.visibility = checked ? 'visible' : 'hidden';
			}),
		};
	}

	private closeOnFocusOut(popup: HTMLElement): void {
		this.popupResources.add(addDisposableListener(popup, 'focusout', event => {
			if (event.relatedTarget && !popup.contains(event.relatedTarget as Node)) { this.hide(); }
		}));
	}

	private registerAccessibility(popup: HTMLElement): void {
		const help = localize('sessions.modelPicker.help', 'Up and Down Arrow move between the model heading and thinking slider. Left and Right Arrow adjust the focused slider; Home and End select its first and last levels. Activate the heading to open the model list, then use Up and Down Arrow, Home or End, and Enter or Space to choose a model. Selection returns to its thinking slider when available. Tab moves between controls. Escape closes the popup and returns to the picker.');
		if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatModelConfiguration) !== false) {
			popup.setAttribute('aria-description', help);
		}
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this.popupResources.add(AccessibleViewRegistry.register({
				type, priority: 115, name: popup.id,
				getProvider: () => {
					const focused = popup.ownerDocument.activeElement as HTMLElement;
					if (!popup.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatModelConfiguration, { type },
						() => type === AccessibleViewType.Help ? help : [
							...this.presentation.models.map(model => model.id === this.presentation.selectedModel
								? localize('sessions.modelPicker.selected', '{0}, selected', model.title) : model.title),
							...this.thinking?.levels.map(level => level.id === this.thinking?.selectedLevel
								? localize('sessions.modelPicker.selected', '{0}, selected', level.label) : level.label) ?? [],
						].join('\n'),
						() => { if (focused.isConnected) { focused.focus(); } else { this.button.focus(); } },
						AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
	}
}
