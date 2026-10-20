//! Lower public RA syntax/semantic queries into owned, scalar control-flow MIR.
//! This intentionally does not inspect the private fields of RA's MIR operands.

use ash_rust_build_ir as ir;
use ra_ap_hir::Function;
use ra_ap_hir::GenericDef;
use ra_ap_hir::HasVisibility;
use ra_ap_hir::Local;
use ra_ap_hir::ModuleDef;
use ra_ap_hir::PathResolution;
use ra_ap_hir::Semantics;
use ra_ap_hir::Type;
use ra_ap_hir::db::HirDatabase;
use ra_ap_syntax::AstNode;
use ra_ap_syntax::SyntaxKind;
use ra_ap_syntax::TextSize;
use ra_ap_syntax::ast;
use ra_ap_syntax::ast::HasArgList;
use ra_ap_syntax::ast::HasAttrs;
use ra_ap_syntax::ast::HasLoopBody;
use ra_ap_syntax::ast::HasName;
use ra_ap_syntax::ast::HasVisibility as HasAstVisibility;
use std::collections::HashMap;

pub(crate) fn program<'db>(
    db: &'db dyn HirDatabase,
    sema: &Semantics<'db, dyn HirDatabase>,
    file: &ast::SourceFile,
    offset: TextSize,
    resolve_source: &dyn Fn(ra_ap_ide::FileId) -> Result<ir::Source, String>,
) -> Result<ir::Program, String> {
    let syntax = file
        .syntax()
        .token_at_offset(offset)
        .right_biased()
        .and_then(|token| token.parent_ancestors().find_map(ast::Fn::cast))
        .ok_or("position is not inside a function")?;
    let root = sema
        .to_def(&syntax)
        .ok_or("function is inactive or unresolved")?;
    let crate_root = resolve_source(root.module(db).krate(db).root_file(db))?.path;
    let mut context = Context {
        db,
        sema,
        resolve_source,
        sources: HashMap::new(),
        standalone: true,
        pending: vec![root],
    };
    let mut functions = Vec::new();
    while functions.len() < context.pending.len() {
        let id = context.pending[functions.len()];
        functions.push(Builder::lower(&mut context, id)?);
    }
    let mut sources: Vec<_> = context.sources.into_values().collect();
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    let program = ir::Program {
        version: ir::VERSION,
        root: 0,
        crate_root,
        functions,
        sources,
        check: if context.standalone {
            ir::CheckMode::Standalone
        } else {
            ir::CheckMode::Package
        },
    };
    ir::validate(&program)?;
    Ok(program)
}

struct Context<'a, 'db> {
    db: &'db dyn HirDatabase,
    sema: &'a Semantics<'db, dyn HirDatabase>,
    resolve_source: &'a dyn Fn(ra_ap_ide::FileId) -> Result<ir::Source, String>,
    sources: HashMap<ra_ap_ide::FileId, ir::Source>,
    standalone: bool,
    pending: Vec<Function>,
}

impl Context<'_, '_> {
    fn function(&mut self, id: Function) -> Result<u32, String> {
        if id.module(self.db).krate(self.db) != self.pending[0].module(self.db).krate(self.db) {
            return Err("cross-crate calls require Cargo".into());
        }
        if id.module(self.db) != self.pending[0].module(self.db) {
            self.standalone = false;
        }
        if let Some(index) = self.pending.iter().position(|candidate| *candidate == id) {
            return Ok(index as u32);
        }
        if self.pending.len() >= ir::MAX_FUNCTIONS {
            return Err("function graph exceeds budget".into());
        }
        self.pending.push(id);
        Ok((self.pending.len() - 1) as u32)
    }

    fn source(&mut self, node: &ra_ap_syntax::SyntaxNode) -> Result<String, String> {
        let original = self.sema.original_range(node);
        let id = original.file_id.file_id(self.db);
        self.record(id)
    }

    fn record(&mut self, id: ra_ap_ide::FileId) -> Result<String, String> {
        if !self.sources.contains_key(&id) {
            let source = (self.resolve_source)(id)?;
            if self.sources.len() >= 64
                || source.text.len() > 2 * 1024 * 1024
                || self
                    .sources
                    .values()
                    .map(|source| source.text.len())
                    .sum::<usize>()
                    + source.text.len()
                    > 4 * 1024 * 1024
            {
                return Err("semantic source graph exceeds budget".into());
            }
            self.sources.insert(id, source);
        }
        Ok(self.sources[&id].path.clone())
    }
}

struct PendingBlock {
    statements: Vec<ir::Assign>,
    terminator: Option<ir::Terminator>,
}

struct Builder<'a, 'b, 'db> {
    context: &'a mut Context<'b, 'db>,
    locals: Vec<ir::Scalar>,
    bindings: HashMap<Local<'db>, u32>,
    blocks: Vec<PendingBlock>,
    current: Option<usize>,
    loops: Vec<(u32, u32)>,
}

impl<'a, 'b, 'db> Builder<'a, 'b, 'db> {
    fn lower(context: &'a mut Context<'b, 'db>, id: Function) -> Result<ir::Function, String> {
        let node = context
            .sema
            .source(id)
            .ok_or("function has no loaded source")?
            .value;
        // Inherent/trait methods and nested items still require other ABI and
        // monomorphization rules. Ordinary module functions retain RA identities.
        if node.syntax().ancestors().skip(1).any(|node| {
            matches!(
                node.kind(),
                SyntaxKind::IMPL | SyntaxKind::TRAIT | SyntaxKind::FN
            )
        }) {
            return Err("methods and nested functions require Cargo".into());
        }
        let source_path = context.source(node.syntax())?;
        for module in id.module(context.db).path_to_root(context.db) {
            if let Some(declaration) = module.declaration_source(context.db) {
                if declaration.value.attrs().any(|attribute| {
                    attribute.path().is_some_and(|path| {
                        matches!(
                            path.syntax().text().to_string().as_str(),
                            "cfg" | "cfg_attr"
                        )
                    })
                }) {
                    return Err(
                        "conditionally selected modules require explicit artifact configuration"
                            .into(),
                    );
                }
                let original = declaration
                    .as_ref()
                    .map(|node| node.syntax())
                    .original_file_range_rooted(context.db);
                context.record(original.file_id.file_id(context.db))?;
            }
        }
        if node.visibility().is_some_and(|visibility| {
            let text: String = visibility
                .syntax()
                .text()
                .to_string()
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect();
            text != "pub" && text != "pub(crate)"
        }) {
            context.standalone = false;
        }
        if !GenericDef::from(id).params(context.db).is_empty()
            || id.is_async(context.db)
            || node.attrs().next().is_some()
            || node.syntax().descendants_with_tokens().any(|element| {
                matches!(
                    element.kind(),
                    SyntaxKind::UNSAFE_KW
                        | SyntaxKind::ASYNC_KW
                        | SyntaxKind::ATTR
                        | SyntaxKind::LABEL
                )
            })
        {
            return Err(
                "generic, attributed, unsafe, async or labelled function requires Cargo".into(),
            );
        }
        let result = scalar(&id.ret_type(context.db))?;
        let body = node.body().ok_or("function has no body")?;
        let params = id.params_without_self(context.db);
        let patterns: Vec<_> = node
            .param_list()
            .ok_or("parameter list missing")?
            .params()
            .collect();
        if patterns.len() != params.len() || patterns.len() > 8 {
            return Err("unsupported parameter list".into());
        }
        let mut builder = Self {
            context,
            locals: vec![result],
            bindings: HashMap::new(),
            blocks: Vec::new(),
            current: None,
            loops: Vec::new(),
        };
        let entry = builder.block()?;
        builder.current = Some(entry as usize);
        let mut parameters = Vec::new();
        for (pattern, parameter) in patterns.iter().zip(params.iter()) {
            let ast::Pat::IdentPat(pattern) = pattern.pat().ok_or("missing parameter pattern")?
            else {
                return Err("destructured parameters require Cargo".into());
            };
            parameters.push(builder.bind(&pattern, scalar(parameter.ty())?)?);
        }
        let value = builder.body(&body)?;
        if builder.current.is_some() {
            builder.assign(0, ir::Rvalue::Use { operand: value });
            builder.terminate(ir::Terminator::Return);
        }
        let body_range = body.syntax().text_range();
        Ok(ir::Function {
            name: id.name(builder.context.db).as_str().to_owned(),
            source_path,
            name_start: node
                .name()
                .ok_or("function name missing")?
                .syntax()
                .text_range()
                .start()
                .into(),
            exclusive: false,
            public: id.visibility(builder.context.db).is_public(),
            source: node.syntax().text().to_string(),
            source_start: node.syntax().text_range().start().into(),
            body_start: body_range.start().into(),
            body_end: body_range.end().into(),
            parameters,
            result,
            locals: builder.locals,
            blocks: builder
                .blocks
                .into_iter()
                .map(|block| ir::Block {
                    statements: block.statements,
                    terminator: block.terminator.unwrap_or(ir::Terminator::Fail),
                })
                .collect(),
        })
    }

    fn block(&mut self) -> Result<u32, String> {
        if self.blocks.len() >= ir::MAX_BLOCKS {
            return Err("MIR block budget exceeded".into());
        }
        let index = self.blocks.len() as u32;
        self.blocks.push(PendingBlock {
            statements: Vec::new(),
            terminator: None,
        });
        Ok(index)
    }

    fn local(&mut self, ty: ir::Scalar) -> Result<u32, String> {
        if self.locals.len() >= ir::MAX_LOCALS {
            return Err("MIR local budget exceeded".into());
        }
        self.locals.push(ty);
        Ok((self.locals.len() - 1) as u32)
    }

    fn bind(&mut self, pattern: &ast::IdentPat, ty: ir::Scalar) -> Result<u32, String> {
        let local = self
            .context
            .sema
            .to_def(pattern)
            .ok_or("unresolved local binding")?;
        if scalar(&local.ty(self.context.db))? != ty {
            return Err("binding type differs from value type".into());
        }
        let index = self.local(ty)?;
        self.bindings.insert(local, index);
        Ok(index)
    }

    fn assign(&mut self, destination: u32, value: ir::Rvalue) {
        if let Some(block) = self.current {
            self.blocks[block]
                .statements
                .push(ir::Assign { destination, value });
        }
    }

    fn terminate(&mut self, terminator: ir::Terminator) {
        if let Some(block) = self.current.take() {
            self.blocks[block].terminator = Some(terminator);
        }
    }

    fn value(&mut self, ty: ir::Scalar, value: ir::Rvalue) -> Result<ir::Operand, String> {
        let index = self.local(ty)?;
        self.assign(index, value);
        Ok(ir::Operand::Local { index })
    }

    fn ty(&self, expression: &ast::Expr) -> Result<ir::Scalar, String> {
        let info = self
            .context
            .sema
            .type_of_expr(expression)
            .ok_or("expression has no inferred type")?;
        // Method receivers and assignment places may have an implicit borrow.
        // Scalar values use the original type; explicit references are rejected.
        let ty = info.original;
        if ty.is_never() {
            return Ok(ir::Scalar::Unit);
        }
        scalar(&ty).map_err(|reason| {
            format!(
                "{reason} in expression `{}`",
                expression
                    .syntax()
                    .text()
                    .to_string()
                    .chars()
                    .take(160)
                    .collect::<String>()
            )
        })
    }

    fn body(&mut self, body: &ast::BlockExpr) -> Result<ir::Operand, String> {
        let statements = body.stmt_list().ok_or("block has no statement list")?;
        for statement in statements.statements() {
            if self.current.is_none() {
                break;
            }
            match statement {
                ast::Stmt::LetStmt(statement) => {
                    let ast::Pat::IdentPat(pattern) =
                        statement.pat().ok_or("missing binding pattern")?
                    else {
                        return Err("destructuring requires Cargo".into());
                    };
                    let initializer = statement
                        .initializer()
                        .ok_or("uninitialized declarations require Cargo")?;
                    let ty = self.ty(&initializer)?;
                    let value = self.expr(initializer)?;
                    let local = self.bind(&pattern, ty)?;
                    self.assign(local, ir::Rvalue::Use { operand: value });
                }
                ast::Stmt::ExprStmt(statement) => {
                    self.expr(statement.expr().ok_or("missing expression")?)?;
                }
                _ => return Err("nested items require Cargo".into()),
            }
        }
        if self.current.is_some()
            && let Some(tail) = statements.tail_expr()
        {
            return self.expr(tail);
        }
        Ok(unit())
    }

    fn path(&self, path: ast::PathExpr) -> Result<u32, String> {
        let resolution = self
            .context
            .sema
            .resolve_path(&path.path().ok_or("missing path")?)
            .ok_or("unresolved path")?;
        let PathResolution::Local(local) = resolution else {
            return Err("external constants, statics and paths require Cargo".into());
        };
        self.bindings
            .get(&local)
            .copied()
            .ok_or_else(|| "local is not in the current function".into())
    }

    fn expr(&mut self, expression: ast::Expr) -> Result<ir::Operand, String> {
        if self.current.is_none() {
            return Ok(unit());
        }
        let ty = self.ty(&expression)?;
        match expression {
            ast::Expr::Literal(literal) => literal_value(&literal.syntax().text().to_string(), ty),
            ast::Expr::PathExpr(path) => {
                if let Some(PathResolution::Def(ModuleDef::Const(constant))) = self
                    .context
                    .sema
                    .resolve_path(&path.path().ok_or("missing path")?)
                {
                    if constant.module(self.context.db).krate(self.context.db)
                        != self.context.pending[0]
                            .module(self.context.db)
                            .krate(self.context.db)
                    {
                        return Err("cross-crate constants require Cargo".into());
                    }
                    let source = self
                        .context
                        .sema
                        .source(constant)
                        .ok_or("constant has no source")?
                        .value;
                    if source.attrs().next().is_some() {
                        return Err("attributed constant requires Cargo".into());
                    }
                    if source.syntax().ancestors().skip(1).any(|node| {
                        matches!(
                            node.kind(),
                            SyntaxKind::IMPL | SyntaxKind::TRAIT | SyntaxKind::FN
                        )
                    }) {
                        return Err("associated and local constants require Cargo".into());
                    }
                    self.context.source(source.syntax())?;
                    self.context.standalone = false;
                    let body = source.body().ok_or("constant has no initializer")?;
                    let ast::Expr::Literal(literal) = body else {
                        return Err("only literal scalar constants are implemented".into());
                    };
                    if scalar(&constant.ty(self.context.db))? != ty {
                        return Err("constant type differs".into());
                    }
                    return literal_value(&literal.syntax().text().to_string(), ty);
                }
                // Read now: a later operand or call argument may assign the same
                // binding. Carrying its storage index would change Rust's order
                // of evaluation (for example, x + { x = 4; 2 }).
                let index = self.path(path)?;
                self.value(
                    ty,
                    ir::Rvalue::Use {
                        operand: ir::Operand::Local { index },
                    },
                )
            }
            ast::Expr::ParenExpr(paren) => self.expr(paren.expr().ok_or("empty parentheses")?),
            ast::Expr::BlockExpr(block) => self.body(&block),
            ast::Expr::PrefixExpr(unary) => {
                let input = unary.expr().ok_or("missing unary operand")?;
                let value = self.expr(input.clone())?;
                let op = match unary.op_kind().ok_or("missing unary operator")? {
                    ast::UnaryOp::Neg => {
                        // Rust permits MIN only as a negated literal. Its positive
                        // token is not itself a representable signed value.
                        if matches!(input, ast::Expr::Literal(_))
                            && ty.signed()
                            && matches!(value, ir::Operand::Constant { bits, .. } if bits == 1u64 << (ty.bits()-1))
                        {
                            return Ok(value);
                        }
                        ir::Unary::Neg
                    }
                    ast::UnaryOp::Not => ir::Unary::Not,
                    ast::UnaryOp::Deref => return Err("pointer dereference requires Cargo".into()),
                };
                self.value(ty, ir::Rvalue::Unary { op, operand: value })
            }
            ast::Expr::CastExpr(cast) => {
                let operand = self.expr(cast.expr().ok_or("missing cast operand")?)?;
                self.value(
                    ty,
                    ir::Rvalue::Cast {
                        operand,
                        scalar: ty,
                    },
                )
            }
            ast::Expr::BinExpr(binary) => self.binary(binary, ty),
            ast::Expr::IfExpr(branch) => {
                let condition = self.expr(branch.condition().ok_or("missing condition")?)?;
                let then_block = self.block()?;
                let else_block = self.block()?;
                let end = self.block()?;
                let local = self.local(ty)?;
                self.terminate(ir::Terminator::Branch {
                    condition,
                    then_block,
                    else_block,
                });
                self.current = Some(then_block as usize);
                let left = self.body(&branch.then_branch().ok_or("missing then block")?)?;
                let left_reaches_end = self.current.is_some();
                self.assign(local, ir::Rvalue::Use { operand: left });
                self.terminate(ir::Terminator::Goto { target: end });
                self.current = Some(else_block as usize);
                let right = match branch.else_branch() {
                    Some(ast::ElseBranch::Block(block)) => self.body(&block)?,
                    Some(ast::ElseBranch::IfExpr(branch)) => {
                        self.expr(ast::Expr::IfExpr(branch))?
                    }
                    None => unit(),
                };
                let right_reaches_end = self.current.is_some();
                self.assign(local, ir::Rvalue::Use { operand: right });
                self.terminate(ir::Terminator::Goto { target: end });
                self.current = (left_reaches_end || right_reaches_end).then_some(end as usize);
                Ok(ir::Operand::Local { index: local })
            }
            ast::Expr::WhileExpr(repeat) => {
                let head = self.block()?;
                let body = self.block()?;
                let end = self.block()?;
                self.terminate(ir::Terminator::Goto { target: head });
                self.current = Some(head as usize);
                let condition = self.expr(repeat.condition().ok_or("missing loop condition")?)?;
                self.terminate(ir::Terminator::Branch {
                    condition,
                    then_block: body,
                    else_block: end,
                });
                self.loops.push((head, end));
                self.current = Some(body as usize);
                self.body(&repeat.loop_body().ok_or("missing loop body")?)?;
                self.terminate(ir::Terminator::Goto { target: head });
                self.loops.pop();
                self.current = Some(end as usize);
                Ok(unit())
            }
            ast::Expr::BreakExpr(exit) if exit.syntax().text().to_string().trim() == "break" => {
                let (_, target) = self.loops.last().copied().ok_or("break outside loop")?;
                self.terminate(ir::Terminator::Goto { target });
                Ok(unit())
            }
            ast::Expr::ContinueExpr(next)
                if next.syntax().text().to_string().trim() == "continue" =>
            {
                let (target, _) = self.loops.last().copied().ok_or("continue outside loop")?;
                self.terminate(ir::Terminator::Goto { target });
                Ok(unit())
            }
            ast::Expr::ReturnExpr(exit) => {
                let operand = match exit.expr() {
                    Some(value) => self.expr(value)?,
                    None => unit(),
                };
                self.assign(0, ir::Rvalue::Use { operand });
                self.terminate(ir::Terminator::Return);
                Ok(unit())
            }
            ast::Expr::CallExpr(call) => {
                let callee = call.expr().ok_or("missing callee")?;
                if callee.syntax().text().to_string().contains("::") {
                    self.context.standalone = false;
                }
                let function = self
                    .context
                    .sema
                    .resolve_expr_as_callable(&callee)
                    .and_then(|callable| callable.as_function())
                    .ok_or("indirect calls require Cargo")?;
                let function = self.context.function(function)?;
                let mut arguments = Vec::new();
                for argument in call.arg_list().ok_or("missing arguments")?.args() {
                    arguments.push(self.expr(argument)?);
                }
                let destination = self.local(ty)?;
                let target = self.block()?;
                self.terminate(ir::Terminator::Call {
                    function,
                    arguments,
                    destination,
                    target,
                });
                self.current = Some(target as usize);
                Ok(ir::Operand::Local { index: destination })
            }
            ast::Expr::MethodCallExpr(call) => {
                let receiver = call.receiver().ok_or("missing receiver")?;
                let scalar = self.ty(&receiver)?;
                if scalar != ty || matches!(scalar, ir::Scalar::Bool | ir::Scalar::Unit) {
                    return Err("non-integer methods require Cargo".into());
                }
                let function = self
                    .context
                    .sema
                    .resolve_method_call(&call)
                    .ok_or("unresolved method")?;
                if function
                    .module(self.context.db)
                    .krate(self.context.db)
                    .display_name(self.context.db)
                    .is_none_or(|name| name.to_string() != "core")
                {
                    return Err("user-defined methods require Cargo".into());
                }
                let op = match function.name(self.context.db).as_str() {
                    "wrapping_add" => ir::Binary::WrappingAdd,
                    "wrapping_sub" => ir::Binary::WrappingSub,
                    "wrapping_mul" => ir::Binary::WrappingMul,
                    "saturating_add" => ir::Binary::SaturatingAdd,
                    "saturating_sub" => ir::Binary::SaturatingSub,
                    "saturating_mul" => ir::Binary::SaturatingMul,
                    "div_ceil" if !scalar.signed() => ir::Binary::DivCeil,
                    _ => return Err("integer method is not implemented".into()),
                };
                let left = self.expr(receiver)?;
                let args: Vec<_> = call
                    .arg_list()
                    .ok_or("missing method arguments")?
                    .args()
                    .collect();
                if args.len() != 1 {
                    return Err("invalid integer method argument count".into());
                }
                let right = self.expr(args[0].clone())?;
                self.value(ty, ir::Rvalue::Binary { op, left, right })
            }
            _ => Err("expression requires the Cargo compiler path".into()),
        }
    }

    fn binary(&mut self, binary: ast::BinExpr, ty: ir::Scalar) -> Result<ir::Operand, String> {
        let left = binary.lhs().ok_or("missing left operand")?;
        let right = binary.rhs().ok_or("missing right operand")?;
        match binary.op_kind().ok_or("missing binary operator")? {
            ast::BinaryOp::Assignment { op } => {
                let ast::Expr::PathExpr(path) = left else {
                    return Err("assignment projection requires Cargo".into());
                };
                let destination = self.path(path)?;
                let right = self.expr(right)?;
                let value = match op {
                    Some(op) => ir::Rvalue::Binary {
                        op: arithmetic(op),
                        left: ir::Operand::Local { index: destination },
                        right,
                    },
                    None => ir::Rvalue::Use { operand: right },
                };
                self.assign(destination, value);
                Ok(unit())
            }
            ast::BinaryOp::LogicOp(op) => {
                let condition = self.expr(left)?;
                let evaluate = self.block()?;
                let constant = self.block()?;
                let end = self.block()?;
                let destination = self.local(ir::Scalar::Bool)?;
                let and = op == ast::LogicOp::And;
                self.terminate(ir::Terminator::Branch {
                    condition,
                    then_block: if and { evaluate } else { constant },
                    else_block: if and { constant } else { evaluate },
                });
                self.current = Some(evaluate as usize);
                let operand = self.expr(right)?;
                self.assign(destination, ir::Rvalue::Use { operand });
                self.terminate(ir::Terminator::Goto { target: end });
                self.current = Some(constant as usize);
                self.assign(
                    destination,
                    ir::Rvalue::Use {
                        operand: ir::Operand::Constant {
                            scalar: ir::Scalar::Bool,
                            bits: u64::from(!and),
                        },
                    },
                );
                self.terminate(ir::Terminator::Goto { target: end });
                self.current = Some(end as usize);
                Ok(ir::Operand::Local { index: destination })
            }
            op => {
                let left = self.expr(left)?;
                let right = self.expr(right)?;
                let op = match op {
                    ast::BinaryOp::ArithOp(op) => arithmetic(op),
                    ast::BinaryOp::CmpOp(op) => match op {
                        ast::CmpOp::Eq { negated } => {
                            if negated {
                                ir::Binary::Ne
                            } else {
                                ir::Binary::Eq
                            }
                        }
                        ast::CmpOp::Ord {
                            ordering: ast::Ordering::Less,
                            strict,
                        } => {
                            if strict {
                                ir::Binary::Lt
                            } else {
                                ir::Binary::Le
                            }
                        }
                        ast::CmpOp::Ord {
                            ordering: ast::Ordering::Greater,
                            strict,
                        } => {
                            if strict {
                                ir::Binary::Gt
                            } else {
                                ir::Binary::Ge
                            }
                        }
                    },
                    ast::BinaryOp::Assignment { .. } | ast::BinaryOp::LogicOp(_) => unreachable!(),
                };
                self.value(ty, ir::Rvalue::Binary { op, left, right })
            }
        }
    }
}

fn arithmetic(op: ast::ArithOp) -> ir::Binary {
    match op {
        ast::ArithOp::Add => ir::Binary::Add,
        ast::ArithOp::Sub => ir::Binary::Sub,
        ast::ArithOp::Mul => ir::Binary::Mul,
        ast::ArithOp::Div => ir::Binary::Div,
        ast::ArithOp::Rem => ir::Binary::Rem,
        ast::ArithOp::Shl => ir::Binary::Shl,
        ast::ArithOp::Shr => ir::Binary::Shr,
        ast::ArithOp::BitAnd => ir::Binary::And,
        ast::ArithOp::BitOr => ir::Binary::Or,
        ast::ArithOp::BitXor => ir::Binary::Xor,
    }
}

fn scalar(ty: &Type<'_>) -> Result<ir::Scalar, String> {
    if ty.contains_unknown() {
        return Err("type contains unknowns".into());
    }
    if ty.is_unit() {
        return Ok(ir::Scalar::Unit);
    }
    let name = ty
        .as_builtin()
        .ok_or("non-scalar type requires Cargo")?
        .name();
    Ok(match name.as_str() {
        "bool" => ir::Scalar::Bool,
        "u8" => ir::Scalar::U8,
        "u16" => ir::Scalar::U16,
        "u32" => ir::Scalar::U32,
        "u64" => ir::Scalar::U64,
        "usize" => ir::Scalar::Usize,
        "i8" => ir::Scalar::I8,
        "i16" => ir::Scalar::I16,
        "i32" => ir::Scalar::I32,
        "i64" => ir::Scalar::I64,
        "isize" => ir::Scalar::Isize,
        _ => return Err("scalar type is not implemented".into()),
    })
}

fn unit() -> ir::Operand {
    ir::Operand::Constant {
        scalar: ir::Scalar::Unit,
        bits: 0,
    }
}

fn literal_value(token: &str, scalar: ir::Scalar) -> Result<ir::Operand, String> {
    let token = token.replace('_', "");
    let bits = if scalar == ir::Scalar::Bool {
        match token.as_str() {
            "true" => 1,
            "false" => 0,
            _ => return Err("invalid bool literal".into()),
        }
    } else {
        let (base, digits) = if let Some(digits) = token.strip_prefix("0x") {
            (16, digits)
        } else if let Some(digits) = token.strip_prefix("0o") {
            (8, digits)
        } else if let Some(digits) = token.strip_prefix("0b") {
            (2, digits)
        } else {
            (10, token.as_str())
        };
        let digits: String = digits
            .chars()
            .take_while(|digit| digit.is_digit(base))
            .collect();
        u64::from_str_radix(&digits, base).map_err(|error| error.to_string())?
    };
    Ok(ir::Operand::Constant { scalar, bits })
}
