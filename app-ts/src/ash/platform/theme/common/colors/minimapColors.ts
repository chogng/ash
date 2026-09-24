import { registerColor } from "../colorUtils.js";
import {
	scrollbarSliderActiveBackground,
	scrollbarSliderBackground,
	scrollbarSliderHoverBackground,
} from "./miscColors.js";

const owner = "platform.theme.minimap";
const alias = (id: string, value: string, description: string): string => registerColor(id, {
	dark: value,
	light: value,
	highContrastDark: value,
	highContrastLight: value,
}, { description, owner });

export const minimapSliderBackground = alias("minimapSlider.background", scrollbarSliderBackground, "Minimap viewport slider background.");
export const minimapSliderHoverBackground = alias("minimapSlider.hoverBackground", scrollbarSliderHoverBackground, "Hovered minimap viewport slider background.");
export const minimapSliderActiveBackground = alias("minimapSlider.activeBackground", scrollbarSliderActiveBackground, "Dragged minimap viewport slider background.");
