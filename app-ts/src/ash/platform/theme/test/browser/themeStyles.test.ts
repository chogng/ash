import { strict as assert } from "node:assert";
import { test } from "mocha";
import { bindColorTheme } from "../../browser/themeStyles.js";
import {
	ColorId,
	colorCssVariable,
	darkColorTheme,
	lightColorTheme,
	sizeCssVariable,
} from "../../common/colorTheme.js";
import { TestThemeService } from "../common/testThemeService.js";
import { registerColor } from "../../common/colorRegistry.js";

test("color theme binding applies changes and restores prior root styles", () => {
	using service = new TestThemeService(darkColorTheme);
	const target = new FakeThemeTarget();
	const foreground = colorCssVariable(ColorId.foreground);
	const background = colorCssVariable(ColorId.workbenchBackground);
	const chatTabBackground = colorCssVariable(ColorId.chatTabBackground);
	const editorTabBackground = colorCssVariable(ColorId.editorTabBackground);
	const menuSelectionForeground = colorCssVariable(ColorId.menuSelectionForeground);
	const menuSelectionBackground = colorCssVariable(ColorId.menuSelectionBackground);
	const actionBarToggledBackground = colorCssVariable(ColorId.actionBarToggledBackground);
	const tabListActiveBackground = colorCssVariable(ColorId.tabListActiveBackground);
	target.style.setProperty(foreground, "hotpink", "important");
	target.style.setProperty("color-scheme", "only light");
	target.setAttribute("data-color-theme", "host-theme");

	const binding = bindColorTheme(
		service,
		target as unknown as HTMLElement,
	);
	assert.equal(target.style.getPropertyValue(foreground), "#cccccc");
	assert.equal(target.style.getPropertyValue(background), "#1e1e1e");
	assert.equal(target.style.getPropertyValue(chatTabBackground), "#eeeeee");
	assert.equal(target.style.getPropertyValue(editorTabBackground), "#eeeeee");
	assert.equal(target.style.getPropertyValue(menuSelectionForeground), "#cccccc");
	assert.equal(target.style.getPropertyValue(menuSelectionBackground), "#2a2d2e");
	assert.equal(target.style.getPropertyValue(actionBarToggledBackground), "#37373d");
	assert.equal(target.style.getPropertyValue(tabListActiveBackground), "#04395e");
	assert.equal(target.style.getPropertyValue("color-scheme"), "dark");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("scrollbar.size")), "10px");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("tabList.contentInset")), "4px");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("tabList.itemContentInset")), "6px");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("fontSize.body1")), "13px");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("fontSize.label2")), "11px");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("fontWeight.regular")), "400");
	assert.equal(target.getAttribute("data-color-theme"), "ash-dark");

	service.setColorTheme(lightColorTheme);
	assert.equal(target.style.getPropertyValue(background), "#ffffff");
	assert.equal(target.style.getPropertyValue(chatTabBackground), "#eeeeee");
	assert.equal(target.style.getPropertyValue(editorTabBackground), "#eeeeee");
	assert.equal(target.style.getPropertyValue(menuSelectionForeground), "#3b3b3b");
	assert.equal(target.style.getPropertyValue(menuSelectionBackground), "#e8e8e8");
	assert.equal(target.style.getPropertyValue(actionBarToggledBackground), "#e4e6f2");
	assert.equal(target.style.getPropertyValue(tabListActiveBackground), "#0060c0");
	assert.equal(target.style.getPropertyValue("color-scheme"), "light");
	assert.equal(target.getAttribute("data-color-theme"), "ash-light");

	binding.dispose();
	assert.equal(target.style.getPropertyValue(foreground), "hotpink");
	assert.equal(target.style.getPropertyPriority(foreground), "important");
	assert.equal(target.style.getPropertyValue(background), "");
	assert.equal(target.style.getPropertyValue(chatTabBackground), "");
	assert.equal(target.style.getPropertyValue(editorTabBackground), "");
	assert.equal(target.style.getPropertyValue(actionBarToggledBackground), "");
	assert.equal(target.style.getPropertyValue(tabListActiveBackground), "");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("scrollbar.size")), "");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("tabList.contentInset")), "");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("tabList.itemContentInset")), "");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("fontSize.body1")), "");
	assert.equal(target.style.getPropertyValue(sizeCssVariable("fontWeight.regular")), "");
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
