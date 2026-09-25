import { strict as assert } from "node:assert";
import { test } from "mocha";
import { bindColorTheme } from "../../browser/themeStyles.js";
import {
	darkColorTheme,
	lightColorTheme,
} from "../../common/colorTheme.js";
import { colorCssVariable } from "../../common/colorUtils.js";
import { foreground } from "../../common/colors/baseColors.js";
import { actionBarToggledBackground, tabListActiveBackground } from "../../common/colors/componentColors.js";
import { editorBackground } from "../../common/colors/editorColors.js";
import { menuSelectionBackground, menuSelectionForeground } from "../../common/colors/menuColors.js";
import { TestThemeService } from "../common/testThemeService.js";
import { registerColor } from "../../common/colorUtils.js";
import { asCssVariableName } from "../../common/sizeUtils.js";

test("color theme binding applies changes and restores prior root styles", () => {
	using service = new TestThemeService(darkColorTheme);
	const target = new FakeThemeTarget();
	const foregroundVariable = colorCssVariable(foreground);
	const background = colorCssVariable(editorBackground);
	const sashHoverBackground = colorCssVariable('sash.hoverBackground');
	const menuSelectionForegroundVariable = colorCssVariable(menuSelectionForeground);
	const menuSelectionBackgroundVariable = colorCssVariable(menuSelectionBackground);
	const actionBarToggledBackgroundVariable = colorCssVariable(actionBarToggledBackground);
	const tabListActiveBackgroundVariable = colorCssVariable(tabListActiveBackground);
	target.style.setProperty(foregroundVariable, "hotpink", "important");
	target.style.setProperty("color-scheme", "only light");
	target.setAttribute("data-color-theme", "host-theme");

	const binding = bindColorTheme(
		service,
		target as unknown as HTMLElement,
	);
	assert.equal(target.style.getPropertyValue(foregroundVariable), "#cccccc");
	assert.equal(target.style.getPropertyValue(background), "#1e1e1e");
	assert.equal(target.style.getPropertyValue(sashHoverBackground), "#007acc");
	assert.equal(target.style.getPropertyValue(menuSelectionForegroundVariable), "#cccccc");
	assert.equal(target.style.getPropertyValue(menuSelectionBackgroundVariable), "#2a2d2e");
	assert.equal(target.style.getPropertyValue(actionBarToggledBackgroundVariable), "#37373d");
	assert.equal(target.style.getPropertyValue(tabListActiveBackgroundVariable), "#04395e");
	assert.equal(target.style.getPropertyValue("color-scheme"), "dark");
	assert.equal(target.style.getPropertyValue(asCssVariableName("scrollbar.size")), "10px");
	assert.equal(target.style.getPropertyValue(asCssVariableName("tabList.contentInset")), "4px");
	assert.equal(target.style.getPropertyValue(asCssVariableName("tabList.itemContentInset")), "6px");
	assert.equal(target.style.getPropertyValue(asCssVariableName("fontSize.body1")), "13px");
	assert.equal(target.style.getPropertyValue(asCssVariableName("fontSize.label2")), "11px");
	assert.equal(target.style.getPropertyValue(asCssVariableName("fontWeight.regular")), "400");
	assert.equal(target.getAttribute("data-color-theme"), "ash-dark");

	service.setColorTheme(lightColorTheme);
	assert.equal(target.style.getPropertyValue(background), "#ffffff");
	assert.equal(target.style.getPropertyValue(sashHoverBackground), "#007acc");
	assert.equal(target.style.getPropertyValue(menuSelectionForegroundVariable), "#3b3b3b");
	assert.equal(target.style.getPropertyValue(menuSelectionBackgroundVariable), "#e8e8e8");
	assert.equal(target.style.getPropertyValue(actionBarToggledBackgroundVariable), "#e4e6f2");
	assert.equal(target.style.getPropertyValue(tabListActiveBackgroundVariable), "#0060c0");
	assert.equal(target.style.getPropertyValue("color-scheme"), "light");
	assert.equal(target.getAttribute("data-color-theme"), "ash-light");

	binding.dispose();
	assert.equal(target.style.getPropertyValue(foregroundVariable), "hotpink");
	assert.equal(target.style.getPropertyPriority(foregroundVariable), "important");
	assert.equal(target.style.getPropertyValue(background), "");
	assert.equal(target.style.getPropertyValue(sashHoverBackground), "");
	assert.equal(target.style.getPropertyValue(actionBarToggledBackgroundVariable), "");
	assert.equal(target.style.getPropertyValue(tabListActiveBackgroundVariable), "");
	assert.equal(target.style.getPropertyValue(asCssVariableName("scrollbar.size")), "");
	assert.equal(target.style.getPropertyValue(asCssVariableName("tabList.contentInset")), "");
	assert.equal(target.style.getPropertyValue(asCssVariableName("tabList.itemContentInset")), "");
	assert.equal(target.style.getPropertyValue(asCssVariableName("fontSize.body1")), "");
	assert.equal(target.style.getPropertyValue(asCssVariableName("fontWeight.regular")), "");
	assert.equal(target.style.getPropertyValue("color-scheme"), "only light");
	assert.equal(target.getAttribute("data-color-theme"), "host-theme");
	assert.equal(target.getAttribute("data-color-scheme"), null);

	service.setColorTheme(darkColorTheme);
	assert.equal(target.style.getPropertyValue(background), "");
});

test("theme binding applies later color contributions and restores their original styles", () => {
	using service = new TestThemeService(darkColorTheme);
	const target = new FakeThemeTarget();
	const property = colorCssVariable('test.lateBinding');
	target.style.setProperty(property, 'hotpink', 'important');
	const before = darkColorTheme.colorEntries;
	using binding = bindColorTheme(service, target as unknown as HTMLElement);
	registerColor('test.lateBinding', { dark: '#123456', light: '#abcdef' }, { description: 'Late binding test.', owner: 'test' });
	assert.deepEqual({
		oldEntry: before.find(entry => entry.id === 'test.lateBinding'),
		resolved: darkColorTheme.getColorCss('test.lateBinding'),
		value: target.style.getPropertyValue(property),
	}, { oldEntry: undefined, resolved: '#123456', value: '#123456' });
	service.setColorTheme(lightColorTheme);
	assert.equal(target.style.getPropertyValue(property), '#abcdef');
	binding.dispose();
	assert.deepEqual([target.style.getPropertyValue(property), target.style.getPropertyPriority(property)], ['hotpink', 'important']);
});

interface IStyleProperty {
	readonly value: string;
	readonly priority: string;
}

class FakeStyle {
	private readonly properties = new Map<string, IStyleProperty>();

	getPropertyValue(name: string): string {
		return this.properties.get(name)?.value ?? "";
	}

	getPropertyPriority(name: string): string {
		return this.properties.get(name)?.priority ?? "";
	}

	setProperty(name: string, value: string, priority = ""): void {
		this.properties.set(name, { value, priority });
	}

	removeProperty(name: string): string {
		const previous = this.getPropertyValue(name);
		this.properties.delete(name);
		return previous;
	}
}

class FakeThemeTarget {
	readonly style = new FakeStyle();
	private readonly attributes = new Map<string, string>();

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
}
