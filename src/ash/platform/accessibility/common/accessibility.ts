import type { Event } from "../../../base/common/event.js";
import { RawContextKey } from "../../contextkey/common/contextkey.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../configuration/common/configurationRegistry.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import { Registry } from "../../registry/common/platform.js";

/** The resolved state of native screen-reader support. */
export enum AccessibilitySupport {
	/** The host cannot determine whether a screen reader is attached. */
	Unknown = 0,
	/** The host has determined that screen-reader support is not active. */
	Disabled = 1,
	/** The host has determined that screen-reader support is active. */
	Enabled = 2,
}

/** The user policy for optimizing editors and workbench interactions. */
export type AccessibilitySupportConfiguration = "auto" | "off" | "on";

/** The user policy for motion and transparency reduction. */
export type AccessibilityReductionConfiguration = "auto" | "off" | "on";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

const triStateSettingOptions = [
	{ value: "auto", label: "Auto" },
	{ value: "on", label: "On" },
	{ value: "off", label: "Off" },
] as const;

/** Configuration keys consumed by the shared accessibility service. */
export const AccessibilityConfiguration = Object.freeze({
	editorAccessibilitySupport: configurationRegistry.registerConfiguration<AccessibilitySupportConfiguration>({
		key: "editor.accessibilitySupport",
		defaultValue: "auto",
		parse: parseAccessibilitySupportConfiguration,
		setting: {
			valueType: "select",
			title: "Screen reader optimization",
			description: "Let the operating system decide, or explicitly enable or disable optimized editor accessibility behavior.",
			options: triStateSettingOptions,
		},
	}),
	reduceMotion: configurationRegistry.registerConfiguration<AccessibilityReductionConfiguration>({
		key: "workbench.reduceMotion",
		defaultValue: "auto",
		parse: parseAccessibilityReductionConfiguration,
		setting: {
			valueType: "select",
			title: "Reduce motion",
			description: "Limit non-essential animation throughout the Workbench.",
			options: triStateSettingOptions,
		},
	}),
	reduceTransparency: configurationRegistry.registerConfiguration<AccessibilityReductionConfiguration>({
		key: "workbench.reduceTransparency",
		defaultValue: "off",
		parse: parseAccessibilityReductionConfiguration,
		setting: {
			valueType: "select",
			title: "Reduce transparency",
			description: "Prefer opaque surfaces where the active theme supports them.",
			options: triStateSettingOptions,
		},
	}),
	underlineLinks: configurationRegistry.registerConfiguration<boolean>({
		key: "accessibility.underlineLinks",
		defaultValue: false,
		parse(value: unknown): boolean {
			if (typeof value !== "boolean") {
				throw new TypeError("accessibility.underlineLinks must be a boolean");
			}
			return value;
		},
		setting: {
			valueType: "boolean",
			title: "Always underline links",
			description: "Keep link affordances visible without requiring hover or focus.",
		},
	}),
});

/** Window-scoped accessibility behavior consumed by editors and Workbench Parts. */
export interface IAccessibilityService {
	readonly onDidChangeScreenReaderOptimized: Event<void>;
	readonly onDidChangeReducedMotion: Event<void>;
	readonly onDidChangeReducedTransparency: Event<void>;
	readonly onDidChangeLinkUnderlines: Event<void>;

	alwaysUnderlineAccessKeys(): Promise<boolean>;
	isScreenReaderOptimized(): boolean;
	isMotionReduced(): boolean;
	isTransparencyReduced(): boolean;
	getAccessibilitySupport(): AccessibilitySupport;
	setAccessibilitySupport(accessibilitySupport: AccessibilitySupport): void;
	alert(message: string): void;
	status(message: string): void;
}

export const IAccessibilityService = createServiceIdentifier<IAccessibilityService>("accessibilityService");

/** Context value shared by Workbench and editor keybinding conditions. */
export const CONTEXT_ACCESSIBILITY_MODE_ENABLED = new RawContextKey<boolean>("accessibilityModeEnabled", false);

/** Stable prefix for application-scoped accessible-view history. */
export const ACCESSIBLE_VIEW_SHOWN_STORAGE_PREFIX = "ACCESSIBLE_VIEW_SHOWN_";

/** Validates a semantic label/role pair supplied by a UI consumer. */
export interface IAccessibilityInformation {
	readonly label: string;
	readonly role?: string;
}

export function isAccessibilityInformation(value: unknown): value is IAccessibilityInformation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<IAccessibilityInformation>;
	return typeof candidate.label === "string" && (candidate.role === undefined || typeof candidate.role === "string");
}

function parseAccessibilitySupportConfiguration(value: unknown): AccessibilitySupportConfiguration {
	if (value === "auto" || value === "off" || value === "on") return value;
	throw new TypeError(`editor.accessibilitySupport must be auto, off, or on; received ${String(value)}`);
}

function parseAccessibilityReductionConfiguration(value: unknown): AccessibilityReductionConfiguration {
	if (value === "auto" || value === "off" || value === "on") return value;
	throw new TypeError(`Accessibility reduction setting must be auto, off, or on; received ${String(value)}`);
}
