import ts from "typescript";

const conventionalUiClassPattern = /(?:Part|ViewPane|Widget)$/u;
const explicitPrototypePatchMarker = "@ash-hot-reload patch-prototype";

export interface HotReloadClassAnalysis {
  readonly name: string;
  readonly declaration: string;
  readonly initialization: readonly string[];
}

export interface HotReloadModuleAnalysis {
  readonly syntaxValid: boolean;
  readonly exportNames: readonly string[];
  readonly classNames: readonly string[];
  readonly classes: readonly HotReloadClassAnalysis[];
  readonly moduleBoundary: readonly string[];
}

/** Extracts the runtime-stable and initialization-sensitive surfaces of one Renderer module. */
export function analyzeHotReloadModule(code: string, file = "module.ts"): HotReloadModuleAnalysis {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const explicitOptIn = code.includes(explicitPrototypePatchMarker);
  const classes: HotReloadClassAnalysis[] = [];
  const targetDeclarations = new Set<ts.ClassDeclaration>();
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name || !extendsClause(statement)) continue;
    if (!explicitOptIn && !conventionalUiClassPattern.test(statement.name.text)) continue;
    targetDeclarations.add(statement);
    classes.push(analyzeClass(statement, statement.name, source));
  }
  return {
    syntaxValid: sourceParseDiagnostics(source).length === 0,
    exportNames: collectRuntimeExportNames(source, targetDeclarations),
    classNames: classes.map(entry => entry.name),
    classes,
    moduleBoundary: source.statements.filter(statement => !targetDeclarations.has(statement as ts.ClassDeclaration)).map(statement => statement.getText(source)),
  };
}

function collectRuntimeExportNames(source: ts.SourceFile, targetDeclarations: ReadonlySet<ts.ClassDeclaration>): readonly string[] {
  const names = new Set<string>();
  for (const declaration of targetDeclarations) {
    if (declaration.name) names.add(declaration.name.text);
  }
  for (const statement of source.statements) {
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) collectExportedDeclarationNames(statement, names);
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) names.add((element.propertyName ?? element.name).text);
      }
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) names.add(statement.expression.text);
  }
  return [...names];
}

function collectExportedDeclarationNames(statement: ts.Statement, names: Set<string>): void {
  if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
    names.add(statement.name.text);
    return;
  }
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
    names.add(statement.name.text);
    return;
  }
  if (!ts.isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) collectBindingNames(declaration.name, names);
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
  }
}

/** Explains why a change must rebuild the module rather than patch existing prototypes. */
export function unsafeHotReloadChangeReason(previous: HotReloadModuleAnalysis, next: HotReloadModuleAnalysis): string | undefined {
  if (previous.classNames.join("\0") !== next.classNames.join("\0")) return "persistent UI class set changed";
  if (JSON.stringify(previous.moduleBoundary) !== JSON.stringify(next.moduleBoundary)) return "module imports, exports, declarations, or side effects changed";
  for (let index = 0; index < previous.classes.length; index += 1) {
    const before = previous.classes[index];
    const after = next.classes[index];
    if (before.declaration !== after.declaration) return `${before.name} inheritance or declaration changed`;
    if (JSON.stringify(before.initialization) !== JSON.stringify(after.initialization)) return `${before.name} constructor, field, static state, or decorated member changed`;
  }
  return undefined;
}

function analyzeClass(declaration: ts.ClassDeclaration, name: ts.Identifier, source: ts.SourceFile): HotReloadClassAnalysis {
  return {
    name: name.text,
    declaration: JSON.stringify({
      modifiers: declaration.modifiers?.map(modifier => modifier.getText(source)) ?? [],
      extends: extendsClause(declaration)?.getText(source),
    }),
    initialization: declaration.members.filter(member => !isPrototypePatchableMember(member)).map(member => member.getText(source)),
  };
}

function sourceParseDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
  return (source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
}

function extendsClause(declaration: ts.ClassDeclaration): ts.HeritageClause | undefined {
  return declaration.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword);
}

function isPrototypePatchableMember(member: ts.ClassElement): boolean {
  if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) return false;
  if (hasModifier(member, ts.SyntaxKind.StaticKeyword) || hasRuntimeDecorator(member)) return false;
  return !(member.name && (ts.isComputedPropertyName(member.name) || ts.isPrivateIdentifier(member.name)));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false);
}

function hasRuntimeDecorator(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}
