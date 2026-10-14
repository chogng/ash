import * as l10n from '@vscode/l10n';
import chinese from '../l10n/bundle.l10n.zh-cn.json';
import * as vscode from 'vscode';
const noEvent = () => ({ dispose() { } });
function throwIfCancelled(token) { if (token.isCancellationRequested) throw new Error('Markdown invocation cancelled'); }
const snapshot = document => ({ uri: document.uri.toString(), languageId: document.languageId, version: document.version, text: document.getText() });
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
	l10n.config({ contents: vscode.env.language === 'zh-CN' ? chinese : {} });
	async function provide(request, token) {
		const operation = request.operation;
		const documents = new Map();
		const open = vscode.workspace.textDocuments.map(snapshot);
		const configuration = vscode.workspace.getConfiguration('markdown', request.document ? vscode.Uri.parse(request.document.uri) : undefined);
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
			if (!['inherit', 'ignore', 'hint', 'warning', 'error'].includes(fragmentValidation)) { throw new TypeError('Invalid Markdown file fragment validation'); }
			options.validateMarkdownFileLinkFragments = fragmentValidation === 'inherit' ? options.validateFileLinks : fragmentValidation;
		}
		options.ignoreLinks = validation.ignoredLinks ?? [];
		if (!Array.isArray(options.ignoreLinks) || options.ignoreLinks.some((value) => typeof value !== 'string')) { throw new TypeError('Invalid Markdown ignored links'); }
		if (validation.enabled !== undefined && typeof validation.enabled !== 'boolean') { throw new TypeError('Invalid Markdown validation switch'); }
		const folders = (vscode.workspace.workspaceFolders ?? []).map(value => URI.parse(value.uri.toString()));
		const readDirectory = (resource) =>
			vscode.workspace.fs.readDirectory(vscode.Uri.parse(resource.toString())).then(entries => entries.map(([name, type]) => [name, { isDirectory: (type & vscode.FileType.Directory) !== 0 }]));
		// An unsaved document exists in the editor even when it has no filesystem entry.
		const stat = resource => documents.has(resource.toString()) || open.some(document => document.uri === resource.toString())
			? Promise.resolve({ isDirectory: false })
			: vscode.workspace.fs.stat(vscode.Uri.parse(resource.toString())).then(value => ({ isDirectory: (value.type & vscode.FileType.Directory) !== 0 }), () => undefined);
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
			const openSnapshot = open.find((document) => document.uri === resource.toString());
			if (openSnapshot) { return remember(openSnapshot); }
			if (!(await stat(resource))) { return undefined; }
			return remember(
				snapshot(await vscode.workspace.openTextDocument(vscode.Uri.parse(resource.toString()))),
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
					const value = vscode.workspace.getConfiguration(section, vscode.Uri.parse(folder.toString()));
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
			...(configuration.preferredMdPathExtensionStyle ? { preferredMdPathExtensionStyle: configuration.preferredMdPathExtensionStyle } : {}),
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
					result = (configuration.occurrencesHighlight?.enabled === false ? [] : await service.getDocumentHighlights(document, location, token)).map((value) => ({
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
					const convert = selection => selection ? { range: range(selection.range), ...(selection.parent ? { parent: convert(selection.parent) } : {}) } : undefined;
					result = ((await service.getSelectionRanges(document, request.positions, token)) ?? []).map(convert);
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
					const values = configuration.suggest?.paths?.enabled === false ? [] : await service.getCompletionItems(
						document,
						location,
						{ includeWorkspaceHeaderCompletions: configuration.suggest?.paths?.includeWorkspaceHeaderCompletions ?? 'onDoubleHash' },
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
	}
	const request = (operation, document, fields = {}) => ({ operation, ...(document ? { document: snapshot(document) } : {}), ...fields });
	const location = value => new vscode.Location(vscode.Uri.parse(value.resource), new vscode.Range(value.range.start, value.range.end));
	const edit = value => {
		const result = new vscode.WorkspaceEdit();
		for (const entry of value.entries) {
			if (entry.kind === 'rename') result.renameFile(vscode.Uri.parse(entry.source), vscode.Uri.parse(entry.target), { overwrite: entry.existing === 'overwrite', ignoreIfExists: entry.existing === 'ignore' });
			else for (const value of entry.edits) result.replace(vscode.Uri.parse(entry.resource), new vscode.Range(value.range.start, value.range.end), value.text);
		}
		return result;
	};
	const selector = 'markdown';
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(selector, {
			async provideCompletionItems(document, position, token) {
				const result = await provide(request('completion', document, { position }), token);
				return new vscode.CompletionList(result.items.map(value => ({ ...value, kind: value.kind === 'folder' ? vscode.CompletionItemKind.Folder : value.kind === 'file' ? vscode.CompletionItemKind.File : vscode.CompletionItemKind.Reference, range: new vscode.Range(value.range.start, value.range.end) })), result.isIncomplete);
			}
		}),
		vscode.languages.registerHoverProvider(selector, { provideHover: (document, position, token) => provide(request('hover', document, { position }), token) }),
		vscode.languages.registerDefinitionProvider(selector, { async provideDefinition(document, position, token) { return (await provide(request('definition', document, { position }), token)).map(location); } }),
		vscode.languages.registerReferenceProvider(selector, { async provideReferences(document, position, options, token) { return (await provide(request('references', document, { position, ...options }), token)).map(location); } }),
		vscode.languages.registerRenameProvider(selector, {
			prepareRename: (document, position, token) => provide(request('rename', document, { position, kind: 'prepare' }), token),
			async provideRenameEdits(document, position, newName, token) { return edit(await provide(request('rename', document, { position, kind: 'rename', newName }), token)); },
		}),
		vscode.languages.registerDocumentSymbolProvider(selector, {
			async provideDocumentSymbols(document, token) {
				const convert = values => values.map(value => ({ ...value, kind: value.kind - 1, children: convert(value.children) }));
				return convert(await provide(request('documentSymbols', document), token));
			}
		}),
		vscode.languages.registerFoldingRangeProvider(selector, { provideFoldingRanges: (document, _context, token) => provide(request('foldingRanges', document), token) }),
		vscode.languages.registerDocumentLinkProvider(selector, { async provideDocumentLinks(document, token) { return (await provide(request('documentLinks', document), token)).map(value => ({ ...value, target: vscode.Uri.parse(value.target) })); } }),
		vscode.languages.registerCodeActionsProvider(selector, { async provideCodeActions(document, range, options, token) { return (await provide(request('codeAction', document, { range, only: options.only ? [options.only.value] : [] }), token)).map(value => ({ title: value.title, kind: value.kind ? new vscode.CodeActionKind(value.kind) : undefined, edit: value.edit ? edit(value.edit) : undefined, disabled: value.disabledReason ? { reason: value.disabledReason } : undefined })); } }),
		vscode.languages.registerSelectionRangeProvider(selector, { async provideSelectionRanges(document, positions, token) { return provide(request('selectionRanges', document, { positions }), token); } }),
		vscode.languages.registerWorkspaceSymbolProvider({ async provideWorkspaceSymbols(query, token) { return (await provide(request('workspaceSymbols', undefined, { query }), token)).map(value => ({ name: value.name, kind: value.kind - 1, location: location(value) })); } }),
		vscode.languages.registerDocumentHighlightProvider(selector, { provideDocumentHighlights: (document, position, token) => provide(request('documentHighlights', document, { position }), token) }),
	);
	const diagnostics = vscode.languages.createDiagnosticCollection('markdown');
	const cancellation = new Map();
	async function update(document) {
		if (document.languageId !== 'markdown') return;
		const key = document.uri.toString();
		cancellation.get(key)?.cancel();
		const source = new vscode.CancellationTokenSource();
		cancellation.set(key, source);
		try {
			const result = await provide(request('diagnostics', document), source.token);
			if (!source.token.isCancellationRequested) diagnostics.set(document.uri, result.diagnostics.map(value => { const diagnostic = new vscode.Diagnostic(new vscode.Range(value.range.start, value.range.end), value.message, { error: 0, warning: 1, information: 2, hint: 3 }[value.severity]); diagnostic.code = value.code; diagnostic.source = value.source; return diagnostic; }));
		} finally { if (cancellation.get(key) === source) cancellation.delete(key); source.dispose(); }
	}
	context.subscriptions.push(diagnostics,
		vscode.workspace.onDidOpenTextDocument(update),
		vscode.workspace.onDidChangeTextDocument(event => update(event.document)),
		vscode.workspace.onDidCloseTextDocument(document => { const key = document.uri.toString(); cancellation.get(key)?.cancel(); diagnostics.delete(document.uri); }),
		vscode.workspace.onDidChangeConfiguration(async event => { if (event.affectsConfiguration('markdown')) await Promise.all(vscode.workspace.textDocuments.map(update)); }),
		{ dispose() { for (const source of cancellation.values()) { source.cancel(); source.dispose(); } cancellation.clear(); } },
	);

}
