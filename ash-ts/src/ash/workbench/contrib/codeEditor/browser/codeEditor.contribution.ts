import { getBrowserTextModelService } from "../../../services/textmodelResolver/browser/browserTextModelService.js";
import { registerEditorPane } from "../../../browser/parts/editor/editorRegistry.js";
import { getBrowserTextResourceStore } from "./browserTextResourceStore.js";
import { createBrowserEditorPart, editorBrowserServices } from "./browserEditorPart.js";
import { CODE_EDITOR_ID, matchCodeEditor } from "./codeEditorInput.js";
import { CodeEditorPane } from "./codeEditorPane.js";
import { DIFF_EDITOR_ID, matchDiffEditor } from "./diffEditorInput.js";
import { DiffEditorPane } from "./diffEditorPane.js";
import { bindCodeLensCacheStorage } from "../../../../editor/contrib/codelens/browser/codeLensCache.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { CodeEditorConfiguration, type WrappingIndentSetting } from "../common/editorConfiguration.js";

registerWorkbenchContribution("workbench.contrib.codeLensCachePersistence", WorkbenchPhase.BlockStartup, accessor => bindCodeLensCacheStorage(accessor.get(IStorageService)));

registerEditorPane({
	id: CODE_EDITOR_ID,
	name: "Stanza Code",
	canOpen: matchCodeEditor,
	create: options => {
		if (!options.textFileService) throw new Error("Stanza Code requires the Workbench text file service");
		const resourceStore = getBrowserTextResourceStore(options.textFileService);
		const configuration = options.configurationService;
		return new CodeEditorPane(resourceStore, {
			modelService: getBrowserTextModelService(resourceStore),
			createPart: createBrowserEditorPart,
			textMateService: options.textMateService,
			languageFeaturesService: options.languageFeaturesService,
			languageConfigurationService: options.languageConfigurationService,
			languageDiagnosticsService: options.languageDiagnosticsService,
			instantiationService: options.instantiationService,
			accessibilityService: options.accessibilityService,
			workingCopyService: options.workingCopyService,
			fontFamily: configuration?.getValue(CodeEditorConfiguration.fontFamily) || undefined,
			fontSize: configuration?.getValue(CodeEditorConfiguration.fontSize),
			lineHeight: configuration?.getValue(CodeEditorConfiguration.lineHeight),
			fontLigatures: configuration?.getValue(CodeEditorConfiguration.fontLigatures),
			experimentalGpuAcceleration: configuration?.getValue(CodeEditorConfiguration.experimentalGpuAcceleration),
			lineWrapping: configuration?.getValue(CodeEditorConfiguration.wordWrap),
			wrappingIndent: configuration?.getValue(CodeEditorConfiguration.wrappingIndent),
			minimap: { enabled: configuration?.getValue(CodeEditorConfiguration.minimapEnabled) !== false },
			renderLineHighlight: configuration?.getValue(CodeEditorConfiguration.renderLineHighlight),
			renderLineHighlightOnlyWhenFocus: configuration?.getValue(CodeEditorConfiguration.renderLineHighlightOnlyWhenFocus),
			cursorStyle: configuration?.getValue(CodeEditorConfiguration.cursorStyle),
			cursorBlinking: configuration?.getValue(CodeEditorConfiguration.cursorBlinking),
			cursorSmoothCaretAnimation: configuration?.getValue(CodeEditorConfiguration.cursorSmoothCaretAnimation),
			cursorWidth: configuration?.getValue(CodeEditorConfiguration.cursorWidth),
			cursorHeight: configuration?.getValue(CodeEditorConfiguration.cursorHeight),
			lineNumbers: configuration?.getValue(CodeEditorConfiguration.lineNumbers) === false ? 'off' : 'on',
			guides: {
				indentation: configuration?.getValue(CodeEditorConfiguration.indentationGuides),
				bracketPairs: configuration?.getValue(CodeEditorConfiguration.bracketPairGuides),
				bracketPairsHorizontal: configuration?.getValue(CodeEditorConfiguration.bracketPairHorizontalGuides) === false ? false : 'active',
				highlightActiveBracketPair: configuration?.getValue(CodeEditorConfiguration.highlightActiveBracketPairGuide),
				highlightActiveIndentation: configuration?.getValue(CodeEditorConfiguration.highlightActiveIndentationGuide),
			},
			bracketPairColorization: { enabled: configuration?.getValue(CodeEditorConfiguration.bracketPairColorization) !== false },
			matchBrackets: configuration?.getValue(CodeEditorConfiguration.matchBrackets),
			stickyScroll: { enabled: configuration?.getValue(CodeEditorConfiguration.stickyScroll) !== false },
			indentation: {
				kind: configuration?.getValue(CodeEditorConfiguration.indentationKind),
				tabSize: configuration?.getValue(CodeEditorConfiguration.tabSize),
			},
			showUnicodeHighlights: configuration?.getValue(CodeEditorConfiguration.unicodeHighlights),
			suggestions: configuration?.getValue(CodeEditorConfiguration.suggestions),
			inlineCompletions: configuration?.getValue(CodeEditorConfiguration.inlineCompletions),
			parameterHints: configuration?.getValue(CodeEditorConfiguration.parameterHints),
			inlayHints: { enabled: configuration?.getValue(CodeEditorConfiguration.inlayHints) === false ? 'off' : 'on' },
			codeLens: configuration?.getValue(CodeEditorConfiguration.codeLens),
			colorDecorators: configuration?.getValue(CodeEditorConfiguration.colorDecorators),
			colorDecoratorsActivatedOn: configuration?.getValue(CodeEditorConfiguration.colorDecoratorsActivatedOn),
			colorDecoratorsLimit: configuration?.getValue(CodeEditorConfiguration.colorDecoratorsLimit),
			defaultColorDecorators: configuration?.getValue(CodeEditorConfiguration.defaultColorDecorators),
			formatOnSave: configuration?.getValue(CodeEditorConfiguration.formatOnSave),
			trimTrailingWhitespace: configuration?.getValue(CodeEditorConfiguration.trimTrailingWhitespace),
			trimTrailingWhitespaceInRegexAndStrings: configuration?.getValue(CodeEditorConfiguration.trimTrailingWhitespaceInRegexAndStrings),
			find: configuration ? {
				seedSearchStringFromSelection: configuration.getValue(CodeEditorConfiguration.findSeedFromSelection),
				autoFindInSelection: configuration.getValue(CodeEditorConfiguration.findAutoFindInSelection),
				loop: configuration.getValue(CodeEditorConfiguration.findLoop),
			} : undefined,
			insertFinalNewLine: configuration?.getValue(CodeEditorConfiguration.insertFinalNewLine),
			onSave: options.onSave,
			onOpenLocation: options.onOpenLocation,
			onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
		});
	},
});

registerEditorPane({
	id: DIFF_EDITOR_ID,
	name: "Stanza Diff",
	canOpen: matchDiffEditor,
	create: options => {
		if (!options.textFileService) throw new Error("Stanza Diff requires the Workbench text file service");
		const diffService = options.diffService;
		if (!diffService) throw new Error("Stanza Diff requires the Workbench diff service");
		const resourceStore = getBrowserTextResourceStore(options.textFileService);
		const configuration = options.configurationService;
		return new DiffEditorPane(resourceStore, {
			modelService: getBrowserTextModelService(resourceStore),
			createComputationService: () => diffService.createComputationService(),
			codeEditorService: editorBrowserServices.codeEditorService,
			lineHeight: configuration?.getValue(CodeEditorConfiguration.lineHeight),
			fontFamily: configuration?.getValue(CodeEditorConfiguration.fontFamily) || undefined,
			fontSize: configuration?.getValue(CodeEditorConfiguration.fontSize),
			fontLigatures: configuration?.getValue(CodeEditorConfiguration.fontLigatures),
			showLineNumbers: configuration?.getValue(CodeEditorConfiguration.diffShowLineNumbers),
			showInlineChanges: configuration?.getValue(CodeEditorConfiguration.diffShowInlineChanges),
			loopChanges: configuration?.getValue(CodeEditorConfiguration.diffLoopChanges),
			breadcrumbs: configuration?.getValue(CodeEditorConfiguration.diffBreadcrumbs),
		});
	},
});
