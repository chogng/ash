import * as l10n from '@vscode/l10n';
import chinese from '../l10n/bundle.l10n.zh-cn.json';
import { languages, noEvent, throwIfCancelled } from '@ash/extension/browser';
import picomatch from 'picomatch';
import MarkdownIt from 'markdown-it';
import { createLanguageService, githubSlugifier } from 'vscode-markdown-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';

const match = (pattern, path) => picomatch.isMatch(path, pattern, { dot: true });
const markdownExtensions = /\.(md|markdown|mdown|mkd|mkdn|mdwn|markdn|mdtxt|mdtext|mdc)$/iu;
const parser = new MarkdownIt({ html: true });
const diagnosticOptions = {
	validateReferences: 'warning',
	validateFragmentLinks: 'warning',
	validateFileLinks: 'warning',
	validateMarkdownFileLinkFragments: 'warning',
	validateUnusedLinkDefinitions: 'hint',
	validateDuplicateLinkDefinitions: 'warning',
	ignoreLinks: [],
};
const position = (value) => ({ line: value.line, character: value.character });
const range = (value) => ({ start: position(value.start), end: position(value.end) });

/** Each invocation owns immutable snapshots and parser caches; dirty buffers precede disk reads. */
export async function registerLanguageFeatures(context) {
	l10n.config({ contents: context.language === 'zh-CN' ? chinese : {} });
	context.subscriptions.push(languages.registerLanguageProvider('markdown.languageFeatures', ['markdown'], {
		operations: [
			'completion',
			'definition',
			'references',
			'rename',
			'documentSymbols',
			'foldingRanges',
			'documentLinks',
			'hover',
			'codeAction',
			'diagnostics',
			'selectionRanges',
			'workspaceSymbols',
			'documentHighlights',
		],
		async provideLanguageFeatures(call, request) {
			const operation = request.operation;
			const token = call.cancellationToken;
			const documents = new Map();
			const open = await call.workspace.getTextDocuments();
			const configuration = await call.workspace.getConfiguration('markdown', request.document?.uri ?? null) ?? {};
			const validation = configuration.validate ?? {};
			const options = { ...diagnosticOptions };
			for (const [setting, key] of [
				['referenceLinks', 'validateReferences'],
				['fragmentLinks', 'validateFragmentLinks'],
				['fileLinks', 'validateFileLinks'],
				['unusedLinkDefinitions', 'validateUnusedLinkDefinitions'],
				['duplicateLinkDefinitions', 'validateDuplicateLinkDefinitions'],
			]) {
				const value = validation[setting]?.enabled;
				if (value !== undefined) {
					if (!['ignore', 'hint', 'warning', 'error'].includes(value)) { throw new TypeError(`Invalid Markdown validation setting: ${setting}`); }
					options[key] = value;
				}
			}
			const fragmentValidation = validation.fileLinks?.markdownFragmentLinks;
			if (fragmentValidation !== undefined) {
				if (!['ignore', 'hint', 'warning', 'error'].includes(fragmentValidation)) { throw new TypeError('Invalid Markdown file fragment validation'); }
				options.validateMarkdownFileLinkFragments = fragmentValidation;
			}
			options.ignoreLinks = validation.ignoredLinks ?? [];
			if (!Array.isArray(options.ignoreLinks) || options.ignoreLinks.some((value) => typeof value !== 'string')) { throw new TypeError('Invalid Markdown ignored links'); }
			if (validation.enabled !== undefined && typeof validation.enabled !== 'boolean') { throw new TypeError('Invalid Markdown validation switch'); }
			const folders = (await call.workspace.getWorkspaceFolders()).map((value) => URI.parse(value));
			const readDirectory = (resource) =>
				call.workspace.readDirectory(resource.toString());
			// An unsaved document exists in the editor even when it has no filesystem entry.
			const stat = resource => documents.has(resource.toString()) || open.some(document => document.uri === resource.toString())
				? Promise.resolve({ isDirectory: false })
				: call.workspace.stat(resource.toString());
			const remember = (snapshot) => {
				const previous = documents.get(snapshot.uri);
				if (previous?.getText() === snapshot.text && previous.version === snapshot.version) { return previous; }
				const document = TextDocument.create(
					snapshot.uri,
					snapshot.languageId,
					snapshot.version,
					snapshot.text,
				);
				documents.set(snapshot.uri, document);

				return document;
			};
			const openDocument = async (resource) => {
				if (documents.has(resource.toString())) { return documents.get(resource.toString()); }
				if (!markdownExtensions.test(resource.path)) { return undefined; }
				const snapshot = open.find((document) => document.uri === resource.toString());
				if (snapshot) { return remember(snapshot); }
				if (!(await stat(resource))) { return undefined; }
				return remember(
					await call.workspace.openTextDocument(resource.toString()),
				);
			};
			const allDocuments = async () => {
				const result = new Map(documents);
				async function visit(directory, prefix, exclusions) {
					for (const [name, metadata] of await readDirectory(directory)) {
						throwIfCancelled(token);
						const relative = prefix + name;
						if (
							exclusions.some(
								(pattern) =>
									match(pattern, relative) ||
									match(pattern, relative + '/') ||
									(pattern.startsWith('**/') && match(pattern.slice(3), relative)),
							)
						) { continue; }
						const resource = Utils.joinPath(directory, name);
						if (metadata.isDirectory) { await visit(resource, relative + '/', exclusions); }
						else if (markdownExtensions.test(name)) {
							const document = await openDocument(resource);
							if (document) { result.set(document.uri, document); }
						}
					}
				}
				for (const folder of folders) {
					const exclusions = [];
					for (const section of ['files.exclude', 'search.exclude']) {
						const value = await call.workspace.getConfiguration(section, folder.toString()) ?? {};
						exclusions.push(
							...Object.entries(value)
								.filter(([, enabled]) => enabled === true)
								.map(([pattern]) => pattern),
						);
					}
					await visit(folder, '', exclusions);
				}
				for (const snapshot of open) {
					if (snapshot.languageId === 'markdown') { result.set(snapshot.uri, documents.get(snapshot.uri) ?? remember(snapshot)); }
				}
				return [...result.values()];
			};
			const service = createLanguageService({
				parser: {
					slugifier: githubSlugifier,
					tokenize: async (document) => parser.parse(document.getText(), {}),
				},
				workspace: {
					workspaceFolders: folders,
					onDidChangeMarkdownDocument: noEvent,
					onDidCreateMarkdownDocument: noEvent,
					onDidDeleteMarkdownDocument: noEvent,
					getAllMarkdownDocuments: allDocuments,
					hasMarkdownDocument: (resource) => documents.has(resource.toString()),
					openMarkdownDocument: openDocument,
					stat,
					readDirectory,
				},
				logger: { level: 0, log() { } },
			});
			try {
				async function workspaceEdit(edit) {
					const entries = [];
					if (!edit) { return { entries }; }
					async function textEdits(resource, edits) {
						const document = await openDocument(URI.parse(resource));
						if (!document) { throw new Error(`Markdown edit document is missing: ${resource}`); }
						entries.push({
							kind: 'textDocument',
							resource,
							expectedText: document.getText(),
							edits: edits.map((edit) => ({ range: range(edit.range), text: edit.newText })),
						});
					}
					for (const [resource, edits] of Object.entries(edit.changes ?? {})) { await textEdits(resource, edits); }
					// Keep the language service's ordering: moving a link target and updating its references form one transaction.
					for (const document of edit.documentChanges ?? []) {
						if ('textDocument' in document) { await textEdits(document.textDocument.uri, document.edits); }
						else if (document.kind === 'rename') {
							entries.push({
								kind: 'rename', source: document.oldUri, target: document.newUri,
								existing: document.options?.overwrite ? 'overwrite' : document.options?.ignoreIfExists ? 'ignore' : 'error',
							});
						} else { throw new Error(`Unsupported Markdown file edit: ${document.kind}`); }
					}
					return { entries };
				}
				throwIfCancelled(token);
				const document =
					operation === 'workspaceSymbols'
						? undefined
						: remember({
							uri: request.document.uri,
							languageId: 'markdown',
							version: request.document.version,
							text: request.document.text,
						});
				const location = request.position;
				let result;
				switch (operation) {
					case 'documentHighlights':
						result = (await service.getDocumentHighlights(document, location, token)).map((value) => ({
							range: range(value.range),
							kind: value.kind ?? 1,
						}));
						break;
					case 'workspaceSymbols':
						result = (await service.getWorkspaceSymbols(request.query, token)).map((symbol) => ({
							name: symbol.name,
							kind: symbol.kind,
							resource: symbol.location.uri,
							range: range(symbol.location.range),
						}));
						break;
					case 'selectionRanges': {
						result = [];
						for (let selection of (await service.getSelectionRanges(
							document,
							request.positions,
							token,
						)) ?? []) {
							while (selection) {
								result.push(range(selection.range));
								selection = selection.parent;
							}
						}
						break;
					}
					case 'diagnostics':
						result = {
							diagnostics: (validation.enabled === false
								? []
								: await service.computeDiagnostics(document, options, token)
							).map((diagnostic) => ({
								range: range(diagnostic.range),
								severity: ['error', 'warning', 'information', 'hint'][diagnostic.severity - 1],
								message: diagnostic.message,
								...(diagnostic.code ? { code: String(diagnostic.code) } : {}),
							})),
						};
						break;
					case 'documentSymbols': {
						const symbols = (values) =>
							values.map((value) => ({
								name: value.name,
								kind: value.kind,
								range: range(value.range),
								selectionRange: range(value.selectionRange),
								children: symbols(value.children ?? []),
							}));
						result = symbols(
							await service.getDocumentSymbols(document, { includeLinkDefinitions: true }, token),
						);
						break;
					}
					case 'foldingRanges':
						result = (await service.getFoldingRanges(document, token)).map((value) => ({
							startLine: value.startLine,
							endLine: value.endLine,
							...(value.kind ? { kind: value.kind } : {}),
						}));
						break;
					case 'definition': {
						const value = await service.getDefinition(document, location, token);
						result = (value === undefined ? [] : Array.isArray(value) ? value : [value]).map((value) => ({
							resource: value.uri,
							range: range(value.range),
						}));
						break;
					}
					case 'references':
						result = (
							await service.getReferences(
								document,
								location,
								{ includeDeclaration: request.includeDeclaration },
								token,
							)
						).map((value) => ({ resource: value.uri, range: range(value.range) }));
						break;
					case 'rename': {
						if (request.kind === 'prepare') {
							const prepared = await service.prepareRename(document, location, token);
							result = prepared
								? { range: range(prepared.range), placeholder: prepared.placeholder }
								: null;
						} else {
							result = await workspaceEdit(
								await service.getRenameEdit(document, location, request.newName, token),
							);
						}
						break;
					}
					case 'documentLinks': {
						result = [];
						for (const link of await service.getDocumentLinks(document, token)) {
							let target = link.target;
							if (!target || target.startsWith('command:')) {
								const resolved = await service.resolveLinkTarget(
									document.getText(link.range),
									URI.parse(document.uri),
									token,
								);
								if (resolved) {
									const point = resolved.positionOrRange?.start ?? resolved.positionOrRange;
									target = (
										point
											? resolved.uri.with({
												fragment: `${point.line + 1},${point.character + 1}`,
											})
											: resolved.fragment ? resolved.uri.with({ fragment: resolved.fragment }) : resolved.uri
									).toString();
								} else {
									const definition = await service.getDefinition(document, link.range.start, token);
									const location = Array.isArray(definition) ? definition[0] : definition;
									if (location) {
										target = URI.parse(location.uri)
											.with({
												fragment: `${location.range.start.line + 1},${location.range.start.character + 1}`,
											})
											.toString();
									}
								}
							}
							if (target && !target.startsWith('command:')) { result.push({ range: range(link.range), target }); }
						}
						break;
					}
					case 'completion': {
						const values = await service.getCompletionItems(
							document,
							location,
							{ includeWorkspaceHeaderCompletions: 'onDoubleHash' },
							token,
						);
						result = {
							isIncomplete: false,
							items: values.map((value, index) => ({
								id: `markdown.${index}`,
								label: value.label,
								kind: value.kind === 19 ? 'folder' : value.kind === 17 ? 'file' : 'reference',
								insertText: value.textEdit?.newText ?? value.insertText ?? value.label,
								insertTextFormat: 'plainText',
								range: range(value.textEdit?.range ?? { start: location, end: location }),
								...(value.detail ? { detail: value.detail } : {}),
							})),
						};
						break;
					}
					case 'hover': {
						const value = await service.getHover(document, location, token);
						result = value
							? {
								contents: (Array.isArray(value.contents) ? value.contents : [value.contents]).map(
									(content) => (typeof content === 'string' ? content : content.value),
								),
								...(value.range ? { range: range(value.range) } : {}),
							}
							: null;
						break;
					}
					case 'codeAction': {
						const diagnostics = await service.computeDiagnostics(document, options, token);
						const actions = await service.getCodeActions(
							document,
							request.range,
							{ diagnostics, ...(request.only.length ? { only: request.only } : {}) },
							token,
						);
						result = [];
						for (const action of actions) {
							result.push({
								title: l10n.t(action.title),
								...(action.kind ? { kind: action.kind } : {}),
								...(action.edit ? { edit: await workspaceEdit(action.edit) } : {}),
								...(action.disabled ? { disabledReason: action.disabled.reason } : {}),
							});
						}
						if (
							!request.only.length ||
							request.only.some(
								(kind) =>
									kind === 'source.organizeLinkDefinitions' ||
									'source.organizeLinkDefinitions'.startsWith(kind + '.'),
							)
						) {
							const edits = await service.organizeLinkDefinitions(
								document,
								{ removeUnused: false },
								token,
							);
							if (edits.length) {
								result.push({
									title: l10n.t('Organize Link Definitions'),
									kind: 'source.organizeLinkDefinitions',
									edit: await workspaceEdit({ changes: { [document.uri]: edits } }),
								});
							}
						}
						break;
					}
					default:
						throw new Error(`Unsupported Markdown operation: ${operation}`);
				}
				throwIfCancelled(token);
				return result;
			} finally {
				service.dispose();
			}
		},
	}, ['.', '/', '#', '[', '(']));
}
