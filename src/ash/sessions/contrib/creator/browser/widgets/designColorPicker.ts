import { ColorPicker } from '../../../../../base/browser/ui/colorPicker/colorPicker.js';
import { ContextViewFocusRestore, ContextViewHideReason } from '../../../../../base/browser/ui/contextview/contextview.js';
import type { Color } from '../../../../../base/common/color.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../nls.js';

/** Supplies the Design popup host and accessibility scope; all controls and color state belong to ColorPicker. */
export function createDesignColorPicker(instantiation: IInstantiationService, document: Document, labels: { readonly color: string; readonly value: string; readonly opacity: string; readonly getDocumentColors?: () => readonly Color[]; }): ColorPicker {
	return instantiation.invokeFunction(accessor => {
		const contextViews = accessor.get(IContextViewService);
		const contextKeys = accessor.get(IContextKeyService);
		const configuration = accessor.get(IConfigurationService);
		return new ColorPicker(document, 'input', {
			...labels,
			getPalettes: () => [{ label: localize('sessions.design.documentColors', 'Document colors'), colors: labels.getDocumentColors?.() ?? [] }],
			popup: {
				show: (anchor, panel, onHide) => contextViews.show({ anchor, content: panel, presentation: 'dialog', focusRestore: ContextViewFocusRestore.Previous, onHide: reason => onHide(reason === ContextViewHideReason.OutsidePointer) }),
				hide: () => contextViews.hide(),
				configure: panel => {
					const scoped = contextKeys.createScoped(panel);
					scoped.createKey('sessionsDesignColorPickerFocused', true);
					const title = localize('colorPicker.title', 'Color picker');
					panel.setAttribute('aria-label', configuration.getValue<boolean>(AccessibilityVerbositySettingId.DesignCanvas) ? `${title}. ${localize('sessions.design.colorHelpHint', 'Press Alt+F1 for color picker help.')}` : title);
					return scoped;
				},
			},
		});
	});
}
