import { registerSize, size } from "../sizeRegistry.js";

const owner = "platform.ui";
const dimension = (id: string, value: number, description: string): string => registerSize(id, size(value), { description, owner });
const scalar = (id: string, value: number, description: string): string => registerSize(id, size(value, "unitless"), { description, owner });
const duration = (id: string, value: number, description: string): string => registerSize(id, size(value, "ms"), { description, owner });

export const fontSizeHeading1 = dimension("fontSize.heading1", 26, "Largest heading font size.");
export const fontSizeHeading2 = dimension("fontSize.heading2", 18, "Title heading font size.");
export const fontSizeHeading3 = dimension("fontSize.heading3", 13, "Subtitle heading font size.");
export const fontSizeBody1 = dimension("fontSize.body1", 13, "Primary body font size.");
export const fontSizeBody2 = dimension("fontSize.body2", 11, "Secondary body font size.");
export const fontSizeLabel1 = dimension("fontSize.label1", 12, "Section title and tab label font size.");
export const fontSizeLabel2 = dimension("fontSize.label2", 11, "Metadata label font size.");
export const fontSizeLabel3 = dimension("fontSize.label3", 10, "Badge label font size.");
export const fontWeightRegular = scalar("fontWeight.regular", 400, "Regular font weight for un-emphasized text.");
export const fontWeightMedium = scalar("fontWeight.medium", 500, "Medium font weight for controls, navigation, and other compact emphasized text.");
export const fontWeightSemiBold = scalar("fontWeight.semiBold", 600, "Strong font weight paired with any font-size role for tabs, headings, and emphasized text.");
export const strokeThickness = dimension("strokeThickness", 1, "Standard UI border thickness.");

export const animationDurationFast = duration("animation.durationFast", 120, "Short UI state transition duration.");
export const animationDurationNormal = duration("animation.durationNormal", 200, "Standard UI animation duration.");
export const animationDurationSlow = duration("animation.durationSlow", 350, "Emphasized UI animation duration.");

export const tabHeight = dimension("tab.height", 24, "Standard height for TabList tabs.");
export const tabListContentInset = dimension("tabList.contentInset", 4, "Horizontal inset between an inset TabList and its first or last tab.");
export const tabListItemContentInset = dimension("tabList.itemContentInset", 6, "Horizontal inset between a TabList item's edge and its label content.");
export const compositeBarContentInset = dimension("compositeBar.contentInset", 4, "Horizontal inset between a CompositeBar and its first or last action.");
export const paneTitleHeight = dimension("pane.titleHeight", 32, "Standard height for a Workbench pane title.");
export const actionBarGap = dimension("actionBar.gap", 2, "Gap between action bar items.");
export const toolbarItemGap = dimension("toolbar.itemGap", 2, "Gap before a toolbar item.");
export const toolbarActionSize = dimension("toolbar.actionSize", 22, "Default square toolbar action size.");
export const scrollbarSize = dimension("scrollbar.size", 10, "Default scrollbar thickness.");
export const treeIndent = dimension("tree.indent", 14, "Default tree nesting indentation.");
export const sashDragAreaSize = dimension("sash.dragAreaSize", 4, "Default pointer target size for draggable Sash separators.");
export const sashHoverFeedbackSize = dimension("sash.hoverFeedbackSize", 1, "Default visible feedback size for hovered Sash separators.");
export const modalEditorWidth = dimension("modalEditor.width", 960, "Preferred modal editor width.");
export const modalEditorHeight = dimension("modalEditor.height", 720, "Preferred modal editor height.");
