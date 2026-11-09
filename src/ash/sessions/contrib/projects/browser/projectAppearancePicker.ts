import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { trapTabFocus } from '../../../../base/browser/focus.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ContextView, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { IconSelectBox } from '../../../../base/browser/ui/icons/iconSelectBox.js';
import { getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { getAllLxicons } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { ProjectAppearance } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { getAppearanceColors } from '../../sessions/browser/views/sessionGroupAppearancePicker.js';

/** Owns the appearance picker and previews the draft on its trigger. */
export class ProjectAppearancePicker extends Disposable {
	private readonly view: ContextView;
	private readonly popup = this._register(new MutableDisposable<DisposableStore>());
	private readonly button: Button;
	private draft: ProjectAppearance;

	constructor(container: HTMLElement, triggerContainer: HTMLElement, private readonly defaultIcon: Icon, initial: ProjectAppearance = {}) {
		super();
		this.draft = { icon: initial.icon, color: initial.color };
		this.view = this._register(new ContextView(container));
		const label = localize('projects.appearance', 'Change project appearance');
		this.button = this._register(new Button(triggerContainer, {
			...defaultButtonStyles,
			label, title: label, icon: defaultIcon, iconOnly: true, presentation: 'quiet',
			onClick: () => this.show(label),
		}));
		this.button.domNode.classList.add('ash-project-appearance-trigger');
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this.updatePreview();
	}

	focus(): void {
		this.button.focus();
	}

	get appearance(): ProjectAppearance {
		return this.draft;
	}

	set enabled(enabled: boolean) {
		this.button.enabled = enabled;
		if (!enabled) this.view.hide();
	}

	private show(label: string): void {
		if (this.view.visible) {
			this.view.hide();
			return;
		}
		const store = this.popup.value = new DisposableStore();
		const anchor = this.button.domNode;
		const document = anchor.ownerDocument;
		const window = getWindow(anchor);
		const panel = h(document, 'div', {
			className: 'ash-project-appearance',
			attributes: { role: 'dialog', 'aria-label': label },
		});
		const colors = h(document, 'div', {
			className: 'ash-project-appearance-colors',
			attributes: { role: 'group', 'aria-label': localize('projects.appearanceColors', 'Icon color') },
		});
		const swatches: readonly [string | undefined, string][] = [
			[undefined, localize('sessions.list.groupAppearanceDefault', 'Default')],
			...getAppearanceColors(this.draft.color),
		];
		const colorButtons = new Map<string | undefined, HTMLButtonElement>();
		for (const [color, name] of swatches) {
			const swatch = h(document, 'span', { attributes: { 'aria-hidden': 'true' } });
			swatch.style.backgroundColor = color ? `var(${colorCssVariable(color)})` : 'currentColor';
			const button = h(document, 'button', {
				attributes: { type: 'button', 'aria-label': name, 'aria-pressed': String(this.draft.color === color), title: name },
			}, swatch);
			store.add(addDisposableListener(button, 'click', () => {
				this.draft = { ...this.draft, color };
				this.updatePreview();
				for (const [id, candidate] of colorButtons) {
					candidate.setAttribute('aria-pressed', String(id === color));
				}
			}));
			colors.append(button);
			colorButtons.set(color, button);
		}
		const grid = store.add(new IconSelectBox({
			icons: [this.defaultIcon, ...getAllLxicons().filter(icon => icon.id !== this.defaultIcon.id)],
			selectedIconId: this.draft.icon ?? this.defaultIcon.id,
			inputBoxStyles: defaultInputBoxStyles,
			controls: colors,
		}, document));
		store.add(grid.onDidSelect(icon => {
			this.draft = { ...this.draft, icon: icon.id === this.defaultIcon.id ? undefined : icon.id };
			this.updatePreview();
		}));
		const footer = h(document, 'div', { className: 'ash-project-appearance-footer' });
		store.add(new Button(footer, {
			...defaultButtonStyles,
			label: localize('projects.appearanceDone', 'Done'),
			presentation: 'secondary',
			onClick: () => this.view.hide(),
		}));
		panel.append(grid.domNode, footer);
		store.add(trapTabFocus(panel));
		const layout = () => grid.layout({
			width: Math.min(376, Math.max(0, window.innerWidth - 32)),
			height: Math.min(280, Math.max(0, window.innerHeight - 64)),
		});
		store.add(addDisposableListener(window, 'resize', layout));
		layout();
		anchor.focus();
		if (this.view.show({
			anchor,
			content: panel,
			presentation: 'menu',
			gap: 4,
			blockOutsidePointer: true,
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				anchor.setAttribute('aria-expanded', 'false');
				this.popup.clear();
			},
		})) {
			anchor.setAttribute('aria-expanded', 'true');
			grid.focus();
		}
	}

	private updatePreview(): void {
		const { color, icon } = this.draft;
		const node = this.button.domNode;
		this.button.icon = icon && getRegisteredIcon(icon, node.ownerDocument) || this.defaultIcon;
		node.style.color = color ? `var(${colorCssVariable(color)})` : '';
	}
}
