import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { ExtensionThemeSource } from "./extensionTheme.js";
import type { ExtensionDebugAdapterSource } from "./extensionDebugAdapter.js";
import type { ExtensionFileTemplateSource } from "./extensionFileTemplate.js";
export type { ExtensionDebugAdapterContribution, ExtensionGrammarContribution, ExtensionLanguageContribution, ExtensionManifest, ExtensionSnippetContribution, ExtensionThemeContribution } from "./extensionManifest.js";
export type { ExtensionDebugAdapterDefinition, ExtensionDebugAdapterSource } from "./extensionDebugAdapter.js";
export type { ExtensionThemeCatalog, ExtensionThemeDefinition, ExtensionThemeSource, ExtensionThemeTokenColorRule, ExtensionThemeTokenColorSettings } from "./extensionTheme.js";
export { parseExtensionTheme } from "./extensionTheme.js";
export type { ExtensionFileTemplateCatalog, ExtensionFileTemplateDefinition, ExtensionFileTemplateSource } from "./extensionFileTemplate.js";
export { parseExtensionManifest } from "./extensionManifest.js";

export type ExtensionSourceKind = "builtIn" | "plugin" | "marketplace" | "user";
export type ExtensionDiagnosticCode = "sourceUnavailable" | "invalidManifest" | "duplicateExtension" | "pathEscapesRoot" | "resourceNotFound" | "resourceTooLarge";

/** Workbench-owned public identity for one discovered declarative extension. */
export interface ExtensionDescriptor {
	readonly id: string;
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly displayName: string;
	readonly sourceKind: ExtensionSourceKind;
	readonly manifestSha256: string;
	readonly packageSha256: string;
}

export interface ExtensionDiagnostic {
	readonly source: string;
	readonly subject: string | undefined;
	readonly code: ExtensionDiagnosticCode;
	readonly message: string;
}

/** Immutable Workbench projection of the transport-owned extension catalog. */
export interface ExtensionCatalog {
	readonly generation: number;
	readonly extensions: readonly ExtensionDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export interface ExtensionServiceFailure {
	readonly extension: ExtensionDescriptor | undefined;
	readonly error: unknown;
}

/** Workbench-owned extension lifecycle and declarative contribution boundary. */
export interface IExtensionService extends IDisposable {
	readonly currentCatalog: ExtensionCatalog;
	readonly themes: ExtensionThemeSource;
	readonly fileTemplates: ExtensionFileTemplateSource;
	readonly debugAdapters: ExtensionDebugAdapterSource;
	readonly onDidChange: Event<ExtensionCatalog>;
	readonly onDidFail: Event<ExtensionServiceFailure>;
	start(): Promise<void>;
	reload(): Promise<void>;
}

export const IExtensionService = createServiceIdentifier<IExtensionService>("extensionService");
