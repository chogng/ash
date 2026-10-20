//! Owned scalar MIR exchanged by the development compiler and RA bridge.
//!
//! RA's public semantic API supplies types and bindings. This IR is lowered from
//! that typed syntax: upstream MIR operands are private, and its debug formatting
//! is deliberately not an executable interchange format.

use serde::Deserialize;
use serde::Serialize;

pub const VERSION: u32 = 2;
pub const MAX_FUNCTIONS: usize = 32;
pub const MAX_LOCALS: usize = 256;
pub const MAX_BLOCKS: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scalar {
    Unit,
    Bool,
    U8,
    U16,
    U32,
    U64,
    Usize,
    I8,
    I16,
    I32,
    I64,
    Isize,
}

impl Scalar {
    pub fn bits(self) -> u16 {
        match self {
            Self::Unit | Self::Bool | Self::U8 | Self::I8 => 8,
            Self::U16 | Self::I16 => 16,
            Self::U32 | Self::I32 => 32,
            Self::U64 | Self::I64 | Self::Usize | Self::Isize => 64,
        }
    }

    pub fn signed(self) -> bool {
        matches!(
            self,
            Self::I8 | Self::I16 | Self::I32 | Self::I64 | Self::Isize
        )
    }

    pub fn rust_name(self) -> &'static str {
        match self {
            Self::Unit => "()",
            Self::Bool => "bool",
            Self::U8 => "u8",
            Self::U16 => "u16",
            Self::U32 => "u32",
            Self::U64 => "u64",
            Self::Usize => "usize",
            Self::I8 => "i8",
            Self::I16 => "i16",
            Self::I32 => "i32",
            Self::I64 => "i64",
            Self::Isize => "isize",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Program {
    pub version: u32,
    pub root: u32,
    pub crate_root: String,
    pub functions: Vec<Function>,
    /// Exact semantic inputs; empty only for compiler-owned synthetic IR.
    pub sources: Vec<Source>,
    pub check: CheckMode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckMode {
    #[default]
    Standalone,
    Package,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Function {
    pub name: String,
    pub source_path: String,
    pub name_start: u32,
    /// Only references inside this graph, and no public external callers.
    pub exclusive: bool,
    pub public: bool,
    /// Exact source items for the independent rustc metadata check.
    pub source: String,
    pub source_start: u32,
    pub body_start: u32,
    pub body_end: u32,
    pub parameters: Vec<u32>,
    pub result: Scalar,
    pub locals: Vec<Scalar>,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub statements: Vec<Assign>,
    pub terminator: Terminator,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Assign {
    pub destination: u32,
    pub value: Rvalue,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operand {
    Local { index: u32 },
    Constant { scalar: Scalar, bits: u64 },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Rvalue {
    Use {
        operand: Operand,
    },
    Binary {
        op: Binary,
        left: Operand,
        right: Operand,
    },
    Unary {
        op: Unary,
        operand: Operand,
    },
    Cast {
        operand: Operand,
        scalar: Scalar,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Binary {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    DivCeil,
    Shl,
    Shr,
    And,
    Or,
    Xor,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    WrappingAdd,
    WrappingSub,
    WrappingMul,
    SaturatingAdd,
    SaturatingSub,
    SaturatingMul,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unary {
    Neg,
    Not,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Terminator {
    Return,
    Goto {
        target: u32,
    },
    Branch {
        condition: Operand,
        then_block: u32,
        else_block: u32,
    },
    Call {
        function: u32,
        arguments: Vec<Operand>,
        destination: u32,
        target: u32,
    },
    /// No machine trap may escape into the Rust host; failure is a status return.
    Fail,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Lowered {
    Available { program: Program },
    Unsupported { reason: String },
}

impl Function {
    pub fn operand_type(&self, operand: Operand) -> Result<Scalar, String> {
        match operand {
            Operand::Local { index } => self
                .locals
                .get(index as usize)
                .copied()
                .ok_or_else(|| "MIR local index is out of bounds".into()),
            Operand::Constant { scalar, bits } => {
                if (scalar == Scalar::Bool && bits > 1)
                    || (scalar == Scalar::Unit && bits != 0)
                    || (scalar.bits() < 64 && bits >= (1u64 << scalar.bits()))
                {
                    return Err("MIR constant is outside its scalar width".into());
                }
                Ok(scalar)
            }
        }
    }

    fn rvalue_type(&self, value: &Rvalue) -> Result<Scalar, String> {
        match *value {
            Rvalue::Use { operand } => self.operand_type(operand),
            Rvalue::Cast { operand, scalar } => {
                let input = self.operand_type(operand)?;
                if input == Scalar::Unit || matches!(scalar, Scalar::Unit | Scalar::Bool) {
                    return Err("unsupported MIR cast".into());
                }
                Ok(scalar)
            }
            Rvalue::Unary { op, operand } => {
                let ty = self.operand_type(operand)?;
                if ty == Scalar::Unit || matches!(op, Unary::Neg) && !ty.signed() {
                    return Err("invalid unary operation".into());
                }
                Ok(ty)
            }
            Rvalue::Binary { op, left, right } => {
                let left = self.operand_type(left)?;
                let right = self.operand_type(right)?;
                if op == Binary::DivCeil && (left.signed() || left == Scalar::Bool) {
                    return Err("ceiling division requires unsigned integers".into());
                }
                if left == Scalar::Unit || right == Scalar::Unit {
                    return Err("unit is not an integer operand".into());
                }
                if matches!(op, Binary::Shl | Binary::Shr) {
                    if left == Scalar::Bool || right == Scalar::Bool {
                        return Err("bool shift".into());
                    }
                } else if left != right {
                    return Err("binary operand types differ".into());
                }
                if matches!(
                    op,
                    Binary::Eq | Binary::Ne | Binary::Lt | Binary::Le | Binary::Gt | Binary::Ge
                ) {
                    return Ok(Scalar::Bool);
                }
                if left == Scalar::Bool && !matches!(op, Binary::And | Binary::Or | Binary::Xor) {
                    return Err("arithmetic on bool".into());
                }
                Ok(left)
            }
        }
    }
}

/// Checks the untrusted wire representation once before code generation. No
/// pointer, external symbol, recursive call or uninitialized local is admitted.
pub fn validate(program: &Program) -> Result<(), String> {
    if program.version != VERSION
        || program.functions.is_empty()
        || program.functions.len() > MAX_FUNCTIONS
        || program.root as usize >= program.functions.len()
    {
        return Err("invalid MIR program header".into());
    }
    let mut source_paths = std::collections::HashSet::new();
    let mut source_bytes = 0;
    for source in &program.sources {
        source_bytes += source.text.len();
        if source.path.is_empty()
            || source.path.len() > 4096
            || source.path.contains('\\')
            || source.path.starts_with('/')
            || source.path.contains(':')
            || source
                .path
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
            || !source.path.ends_with(".rs")
            || !source_paths.insert(&source.path)
            || source.text.len() > 2 * 1024 * 1024
            || source_bytes > 4 * 1024 * 1024
            || program.sources.len() > 64
        {
            return Err("invalid MIR source snapshot".into());
        }
    }
    let mut edges = vec![Vec::new(); program.functions.len()];
    let mut total_source = 0;
    let mut total_statements = 0;
    for (function_index, function) in program.functions.iter().enumerate() {
        total_source += function.source.len();
        if function.name.is_empty()
            || function.name.len() > 256
            || function.locals.is_empty()
            || function.locals.len() > MAX_LOCALS
            || function.locals[0] != function.result
            || function.parameters.len() > 8
            || function.blocks.is_empty()
            || function.blocks.len() > MAX_BLOCKS
            || total_source > 2 * 1024 * 1024
            || function.source_start > function.body_start
            || function.body_start >= function.body_end
        {
            return Err("invalid MIR function".into());
        }
        if !program.sources.is_empty() {
            let source = program
                .sources
                .iter()
                .find(|source| source.path == function.source_path)
                .ok_or("MIR function has no source snapshot")?;
            let end = function.source_start as usize + function.source.len();
            if source.text.get(function.source_start as usize..end) != Some(&function.source)
                || function.name_start < function.source_start
                || function.name_start >= function.body_start
                || function.body_end as usize > end
            {
                return Err("MIR source ranges differ from snapshot".into());
            }
        }
        let mut entry = vec![false; function.locals.len()];
        for &parameter in &function.parameters {
            let slot = entry
                .get_mut(parameter as usize)
                .ok_or("invalid parameter local")?;
            if parameter == 0 || *slot {
                return Err("duplicate or return parameter local".into());
            }
            *slot = true;
        }
        let mut predecessors = vec![Vec::new(); function.blocks.len()];
        let mut reads = vec![Vec::new(); function.blocks.len()];
        let mut writes = vec![Vec::new(); function.blocks.len()];
        for (index, block) in function.blocks.iter().enumerate() {
            total_statements += block.statements.len();
            if total_statements > 8192 {
                return Err("MIR program statement budget exceeded".into());
            }
            if block.statements.len() > 4096 {
                return Err("MIR statement budget exceeded".into());
            }
            let mut assigned = vec![false; function.locals.len()];
            // The lexical order is retained for the definite-initialization pass.
            for statement in &block.statements {
                let ty = function.rvalue_type(&statement.value)?;
                if function.locals.get(statement.destination as usize) != Some(&ty) {
                    return Err("MIR assignment type mismatch".into());
                }
                for operand in operands(&statement.value) {
                    function.operand_type(operand)?;
                }
                writes[index].push(statement.destination);
            }
            let targets = match &block.terminator {
                Terminator::Return => Vec::new(),
                Terminator::Fail => Vec::new(),
                Terminator::Goto { target } => vec![*target],
                Terminator::Branch {
                    condition,
                    then_block,
                    else_block,
                } => {
                    if function.operand_type(*condition)? != Scalar::Bool {
                        return Err("MIR condition is not bool".into());
                    }
                    vec![*then_block, *else_block]
                }
                Terminator::Call {
                    function: callee,
                    arguments,
                    destination,
                    target,
                } => {
                    edges[function_index].push(*callee as usize);
                    let callee = program
                        .functions
                        .get(*callee as usize)
                        .ok_or("invalid MIR callee")?;
                    if arguments.len() != callee.parameters.len()
                        || function.locals.get(*destination as usize) != Some(&callee.result)
                    {
                        return Err("MIR call signature mismatch".into());
                    }
                    for (&argument, &parameter) in arguments.iter().zip(&callee.parameters) {
                        if function.operand_type(argument)?
                            != *callee
                                .locals
                                .get(parameter as usize)
                                .ok_or("invalid callee parameter")?
                        {
                            return Err("MIR call argument type mismatch".into());
                        }
                    }
                    writes[index].push(*destination);
                    vec![*target]
                }
            };
            for target in targets {
                predecessors
                    .get_mut(target as usize)
                    .ok_or("invalid MIR branch target")?
                    .push(index);
            }
            // Mark statements in order: a read preceding the first assignment is
            // an input requirement; reads following it are local to this block.
            assigned.fill(false);
            reads[index].clear();
            for statement in &block.statements {
                for operand in operands(&statement.value) {
                    if let Operand::Local { index: local } = operand
                        && !assigned[local as usize]
                    {
                        reads[index].push(local);
                    }
                }
                assigned[statement.destination as usize] = true;
            }
            let tail = match &block.terminator {
                Terminator::Return => vec![Operand::Local { index: 0 }],
                Terminator::Branch { condition, .. } => vec![*condition],
                Terminator::Call { arguments, .. } => arguments.clone(),
                Terminator::Fail | Terminator::Goto { .. } => Vec::new(),
            };
            for operand in tail {
                if let Operand::Local { index: local } = operand
                    && !assigned[local as usize]
                {
                    reads[index].push(local);
                }
            }
        }
        // A forward intersection analysis handles loops without treating their
        // back edges as initialization that happened before the first iteration.
        let mut incoming = vec![vec![true; function.locals.len()]; function.blocks.len()];
        incoming[0] = entry.clone();
        loop {
            let mut changed = false;
            for index in 1..function.blocks.len() {
                if predecessors[index].is_empty() {
                    continue;
                }
                let mut next = vec![true; function.locals.len()];
                for &parent in &predecessors[index] {
                    let mut outgoing = incoming[parent].clone();
                    for &local in &writes[parent] {
                        outgoing[local as usize] = true;
                    }
                    for (value, parent) in next.iter_mut().zip(outgoing) {
                        *value &= parent;
                    }
                }
                if next != incoming[index] {
                    incoming[index] = next;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        for (index, requirements) in reads.iter().enumerate() {
            if requirements
                .iter()
                .any(|local| !incoming[index][*local as usize])
            {
                return Err("MIR reads an uninitialized local".into());
            }
        }
    }
    fn visit(
        index: usize,
        edges: &[Vec<usize>],
        active: &mut [bool],
        done: &mut [bool],
    ) -> Result<(), String> {
        if active[index] {
            return Err("recursive MIR calls require Cargo".into());
        }
        if done[index] {
            return Ok(());
        }
        active[index] = true;
        for &callee in &edges[index] {
            visit(callee, edges, active, done)?;
        }
        active[index] = false;
        done[index] = true;
        Ok(())
    }
    visit(
        program.root as usize,
        &edges,
        &mut vec![false; edges.len()],
        &mut vec![false; edges.len()],
    )
}

fn operands(value: &Rvalue) -> Vec<Operand> {
    match *value {
        Rvalue::Use { operand } | Rvalue::Unary { operand, .. } | Rvalue::Cast { operand, .. } => {
            vec![operand]
        }
        Rvalue::Binary { left, right, .. } => vec![left, right],
    }
}

#[cfg(test)]
mod tests;
