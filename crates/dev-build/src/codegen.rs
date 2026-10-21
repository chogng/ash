//! Scalar MIR → Cranelift → relocatable, position-independent code image.
//! Generated calls cannot unwind: all arithmetic failures return a status code.

use crate::machine;
use ash_rust_build_ir as mir;
use cranelift_codegen::ir;
use cranelift_codegen::ir::InstBuilder;
use cranelift_codegen::ir::condcodes::IntCC;
use cranelift_codegen::settings;
use cranelift_codegen::settings::Configurable;
use cranelift_frontend::FunctionBuilder;
use cranelift_frontend::FunctionBuilderContext;
use cranelift_frontend::Variable;
use cranelift_module::FuncId;
use cranelift_module::Linkage;
use cranelift_module::Module;
use cranelift_object::ObjectBuilder;
use cranelift_object::ObjectModule;
use object::Object;
use object::ObjectSection;
use object::ObjectSymbol;
use std::collections::HashMap;

pub(crate) fn compile(program: &mir::Program, overflow_checks: bool) -> Result<Vec<u8>, String> {
    // The compiler boundary validates the owned MIR before the rustc gate.
    let target = machine::target()?;
    let triple = target
        .parse()
        .map_err(|error| format!("invalid target: {error}"))?;
    let mut flags = settings::builder();
    flags
        .set("opt_level", "none")
        .map_err(|error| error.to_string())?;
    flags
        .set("is_pic", "false")
        .map_err(|error| error.to_string())?;
    flags
        .set("unwind_info", "false")
        .map_err(|error| error.to_string())?;
    flags
        .set("enable_verifier", "true")
        .map_err(|error| error.to_string())?;
    let isa = cranelift_codegen::isa::lookup(triple)
        .map_err(|error| error.to_string())?
        .finish(settings::Flags::new(flags))
        .map_err(|error| error.to_string())?;
    let object = ObjectBuilder::new(
        isa,
        "ash-scalar-code",
        cranelift_module::default_libcall_names(),
    )
    .map_err(|error| error.to_string())?;
    let mut module = ObjectModule::new(object);
    let mut ids = Vec::new();
    for (index, function) in program.functions.iter().enumerate() {
        let signature = signature(&module, function);
        ids.push(
            module
                .declare_function(&format!("ash_fn_{index}"), Linkage::Local, &signature)
                .map_err(|error| error.to_string())?,
        );
    }
    for (index, function) in program.functions.iter().enumerate() {
        emit(
            &mut module,
            ids[index],
            function,
            &ids,
            program,
            overflow_checks,
        )?;
    }
    let mut context = module.make_context();
    context.func.signature.params = vec![ir::AbiParam::new(ir::types::I64); 3];
    context.func.signature.returns = vec![ir::AbiParam::new(ir::types::I32)];
    let generic = module
        .declare_function("ash_entry", Linkage::Local, &context.func.signature)
        .map_err(|error| error.to_string())?;
    let root = &program.functions[program.root as usize];
    {
        let root_ref = module.declare_func_in_func(ids[program.root as usize], &mut context.func);
        let mut frontend = FunctionBuilderContext::new();
        let mut builder = FunctionBuilder::new(&mut context.func, &mut frontend);
        let entry = builder.create_block();
        let failure = builder.create_block();
        builder.append_block_params_for_function_params(entry);
        builder.switch_to_block(entry);
        let args = builder.block_params(entry).to_vec();
        let valid = builder
            .ins()
            .icmp_imm_s(IntCC::Equal, args[1], root.parameters.len() as i64);
        let good = builder.create_block();
        builder.ins().brif(valid, good, &[], failure, &[]);
        builder.switch_to_block(good);
        let mut values = Vec::new();
        for (index, &parameter) in root.parameters.iter().enumerate() {
            let value = builder.ins().load(
                ir::types::I64,
                ir::MemFlagsData::new(),
                args[0],
                (index * 8) as i32,
            );
            let ty = root.locals[parameter as usize];
            if ty == mir::Scalar::Bool {
                let invalid = builder
                    .ins()
                    .icmp_imm_s(IntCC::UnsignedGreaterThan, value, 1);
                guard(&mut builder, invalid, failure);
            }
            values.push(convert(&mut builder, value, cl_type(ty), false));
        }
        values.push(args[2]);
        let call = builder.ins().call(root_ref, &values);
        let status = builder.inst_results(call)[0];
        builder.ins().return_(&[status]);
        builder.switch_to_block(failure);
        let status = builder.ins().iconst(ir::types::I32, 2);
        builder.ins().return_(&[status]);
        builder.seal_all_blocks();
        builder.finalize(module.isa().frontend_config());
    }
    module
        .define_function(generic, &mut context)
        .map_err(|error| error.to_string())?;
    let bytes = module.finish().emit().map_err(|error| error.to_string())?;
    flatten(
        &bytes,
        target,
        root.parameters.len(),
        root.parameters.len() == 1
            && root.locals[root.parameters[0] as usize] == mir::Scalar::Usize
            && root.result == mir::Scalar::Usize,
        program.root,
    )
}

fn signature(module: &ObjectModule, function: &mir::Function) -> ir::Signature {
    let mut signature = module.make_signature();
    for &parameter in &function.parameters {
        signature.params.push(ir::AbiParam::new(cl_type(
            function.locals[parameter as usize],
        )));
    }
    signature.params.push(ir::AbiParam::new(ir::types::I64));
    signature.returns.push(ir::AbiParam::new(ir::types::I32));
    signature
}

fn cl_type(ty: mir::Scalar) -> ir::Type {
    match ty.bits() {
        8 => ir::types::I8,
        16 => ir::types::I16,
        32 => ir::types::I32,
        64 => ir::types::I64,
        _ => unreachable!(),
    }
}

fn convert(
    builder: &mut FunctionBuilder<'_>,
    value: ir::Value,
    target: ir::Type,
    signed: bool,
) -> ir::Value {
    let source = builder.func.dfg.value_type(value);
    if source.bits() > target.bits() {
        builder.ins().ireduce(target, value)
    } else if source.bits() < target.bits() {
        if signed {
            builder.ins().sextend(target, value)
        } else {
            builder.ins().uextend(target, value)
        }
    } else {
        value
    }
}

fn operand(
    builder: &mut FunctionBuilder<'_>,
    variables: &[Variable],
    operand: mir::Operand,
) -> ir::Value {
    match operand {
        mir::Operand::Local { index } => builder.use_var(variables[index as usize]),
        mir::Operand::Constant { scalar, bits } => {
            builder.ins().iconst(cl_type(scalar), bits as i64)
        }
    }
}

fn guard(builder: &mut FunctionBuilder<'_>, invalid: ir::Value, failure: ir::Block) {
    let continuation = builder.create_block();
    builder.ins().brif(invalid, failure, &[], continuation, &[]);
    builder.switch_to_block(continuation);
}

fn emit(
    module: &mut ObjectModule,
    id: FuncId,
    function: &mir::Function,
    ids: &[FuncId],
    program: &mir::Program,
    overflow: bool,
) -> Result<(), String> {
    let mut context = module.make_context();
    context.func.signature = signature(module, function);
    let references: Vec<_> = ids
        .iter()
        .map(|id| module.declare_func_in_func(*id, &mut context.func))
        .collect();
    {
        let mut frontend = FunctionBuilderContext::new();
        let mut builder = FunctionBuilder::new(&mut context.func, &mut frontend);
        let blocks: Vec<_> = function
            .blocks
            .iter()
            .map(|_| builder.create_block())
            .collect();
        let failure = builder.create_block();
        builder.append_block_params_for_function_params(blocks[0]);
        let variables: Vec<_> = function
            .locals
            .iter()
            .map(|ty| builder.declare_var(cl_type(*ty)))
            .collect();
        builder.switch_to_block(blocks[0]);
        let params = builder.block_params(blocks[0]).to_vec();
        let output = *params.last().ok_or("missing output parameter")?;
        for (&local, &value) in function.parameters.iter().zip(&params) {
            builder.def_var(variables[local as usize], value);
        }
        for (index, block) in function.blocks.iter().enumerate() {
            builder.switch_to_block(blocks[index]);
            for assign in &block.statements {
                let value = match assign.value {
                    mir::Rvalue::Use { operand: value } => operand(&mut builder, &variables, value),
                    mir::Rvalue::Cast {
                        operand: input,
                        scalar,
                    } => {
                        let signed = function.operand_type(input)?.signed();
                        let value = operand(&mut builder, &variables, input);
                        convert(&mut builder, value, cl_type(scalar), signed)
                    }
                    mir::Rvalue::Unary { op, operand: input } => {
                        let value = operand(&mut builder, &variables, input);
                        let ty = function.operand_type(input)?;
                        match op {
                            mir::Unary::Not => {
                                if ty == mir::Scalar::Bool {
                                    builder.ins().bxor_imm_s(value, 1)
                                } else {
                                    builder.ins().bnot(value)
                                }
                            }
                            mir::Unary::Neg => {
                                if overflow {
                                    let invalid =
                                        builder.ins().icmp_imm_s(IntCC::Equal, value, minimum(ty));
                                    guard(&mut builder, invalid, failure);
                                }
                                builder.ins().ineg(value)
                            }
                        }
                    }
                    mir::Rvalue::Binary { op, left, right } => {
                        let ty = function.operand_type(left)?;
                        let left = operand(&mut builder, &variables, left);
                        let right = operand(&mut builder, &variables, right);
                        binary(&mut builder, op, left, right, ty, overflow, failure)?
                    }
                };
                builder.def_var(variables[assign.destination as usize], value);
            }
            match &block.terminator {
                mir::Terminator::Return => {
                    let result = builder.use_var(variables[0]);
                    builder
                        .ins()
                        .store(ir::MemFlagsData::new(), result, output, 0);
                    let status = builder.ins().iconst(ir::types::I32, 0);
                    builder.ins().return_(&[status]);
                }
                mir::Terminator::Fail => {
                    builder.ins().jump(failure, &[]);
                }
                mir::Terminator::Goto { target } => {
                    builder.ins().jump(blocks[*target as usize], &[]);
                }
                mir::Terminator::Branch {
                    condition,
                    then_block,
                    else_block,
                } => {
                    let condition = operand(&mut builder, &variables, *condition);
                    builder.ins().brif(
                        condition,
                        blocks[*then_block as usize],
                        &[],
                        blocks[*else_block as usize],
                        &[],
                    );
                }
                mir::Terminator::Call {
                    function: callee,
                    arguments,
                    destination,
                    target,
                } => {
                    let mut values: Vec<_> = arguments
                        .iter()
                        .map(|value| operand(&mut builder, &variables, *value))
                        .collect();
                    let slot = builder.create_sized_stack_slot(ir::StackSlotData::new(
                        ir::StackSlotKind::ExplicitSlot,
                        8,
                        3,
                    ));
                    let address = builder.ins().stack_addr(ir::types::I64, slot, 0);
                    values.push(address);
                    let call = builder.ins().call(references[*callee as usize], &values);
                    let status = builder.inst_results(call)[0];
                    let invalid = builder.ins().icmp_imm_s(IntCC::NotEqual, status, 0);
                    guard(&mut builder, invalid, failure);
                    let ty = program.functions[*callee as usize].result;
                    let value = if ty == mir::Scalar::Unit {
                        builder.ins().iconst(ir::types::I8, 0)
                    } else {
                        builder
                            .ins()
                            .stack_load(ir::types::I64, cl_type(ty), slot, 0)
                    };
                    builder.def_var(variables[*destination as usize], value);
                    builder.ins().jump(blocks[*target as usize], &[]);
                }
            }
        }
        builder.switch_to_block(failure);
        let status = builder.ins().iconst(ir::types::I32, 1);
        builder.ins().return_(&[status]);
        builder.seal_all_blocks();
        builder.finalize(module.isa().frontend_config());
    }
    module
        .define_function(id, &mut context)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn minimum(ty: mir::Scalar) -> i64 {
    (1u64 << (ty.bits() - 1)) as i64
}
fn maximum(ty: mir::Scalar) -> i64 {
    ((1u64 << (ty.bits() - 1)) - 1) as i64
}

fn binary(
    builder: &mut FunctionBuilder<'_>,
    op: mir::Binary,
    left: ir::Value,
    right: ir::Value,
    ty: mir::Scalar,
    overflow: bool,
    failure: ir::Block,
) -> Result<ir::Value, String> {
    use mir::Binary as B;
    let comparison = match op {
        B::Eq => Some(IntCC::Equal),
        B::Ne => Some(IntCC::NotEqual),
        B::Lt => Some(if ty.signed() {
            IntCC::SignedLessThan
        } else {
            IntCC::UnsignedLessThan
        }),
        B::Le => Some(if ty.signed() {
            IntCC::SignedLessThanOrEqual
        } else {
            IntCC::UnsignedLessThanOrEqual
        }),
        B::Gt => Some(if ty.signed() {
            IntCC::SignedGreaterThan
        } else {
            IntCC::UnsignedGreaterThan
        }),
        B::Ge => Some(if ty.signed() {
            IntCC::SignedGreaterThanOrEqual
        } else {
            IntCC::UnsignedGreaterThanOrEqual
        }),
        _ => None,
    };
    if let Some(condition) = comparison {
        return Ok(builder.ins().icmp(condition, left, right));
    }
    Ok(match op {
        B::And => builder.ins().band(left, right),
        B::Or => builder.ins().bor(left, right),
        B::Xor => builder.ins().bxor(left, right),
        B::WrappingAdd => builder.ins().iadd(left, right),
        B::WrappingSub => builder.ins().isub(left, right),
        B::WrappingMul => builder.ins().imul(left, right),
        B::Add | B::Sub | B::Mul | B::SaturatingAdd | B::SaturatingSub | B::SaturatingMul => {
            let (value, invalid) = match op {
                B::Add | B::SaturatingAdd => {
                    if ty.signed() {
                        builder.ins().sadd_overflow(left, right)
                    } else {
                        builder.ins().uadd_overflow(left, right)
                    }
                }
                B::Sub | B::SaturatingSub => {
                    if ty.signed() {
                        builder.ins().ssub_overflow(left, right)
                    } else {
                        builder.ins().usub_overflow(left, right)
                    }
                }
                B::Mul | B::SaturatingMul => {
                    if ty.signed() {
                        builder.ins().smul_overflow(left, right)
                    } else {
                        builder.ins().umul_overflow(left, right)
                    }
                }
                _ => unreachable!(),
            };
            if matches!(op, B::SaturatingAdd | B::SaturatingSub | B::SaturatingMul) {
                let bound = if ty.signed() {
                    let sign = if op == B::SaturatingMul {
                        builder.ins().bxor(left, right)
                    } else {
                        left
                    };
                    let negative = builder.ins().icmp_imm_s(IntCC::SignedLessThan, sign, 0);
                    let minimum = builder.ins().iconst(cl_type(ty), minimum(ty));
                    let maximum = builder.ins().iconst(cl_type(ty), maximum(ty));
                    builder.ins().select(negative, minimum, maximum)
                } else {
                    builder
                        .ins()
                        .iconst(cl_type(ty), if op == B::SaturatingSub { 0 } else { -1 })
                };
                builder.ins().select(invalid, bound, value)
            } else {
                if overflow {
                    guard(builder, invalid, failure);
                }
                value
            }
        }
        B::DivCeil => {
            if ty.signed() {
                return Err("signed ceiling division is not implemented".into());
            }
            let invalid = builder.ins().icmp_imm_s(IntCC::Equal, right, 0);
            guard(builder, invalid, failure);
            // Avoid x + divisor - 1: it overflows at valid unsigned boundaries.
            let quotient = builder.ins().udiv(left, right);
            let remainder = builder.ins().urem(left, right);
            let more = builder.ins().icmp_imm_s(IntCC::NotEqual, remainder, 0);
            let more = convert(builder, more, cl_type(ty), false);
            builder.ins().iadd(quotient, more)
        }
        B::Div | B::Rem => {
            let invalid = builder.ins().icmp_imm_s(IntCC::Equal, right, 0);
            guard(builder, invalid, failure);
            if ty.signed() {
                let is_min = builder.ins().icmp_imm_s(IntCC::Equal, left, minimum(ty));
                let is_negative_one = builder.ins().icmp_imm_s(IntCC::Equal, right, -1);
                let invalid = builder.ins().band(is_min, is_negative_one);
                guard(builder, invalid, failure);
                if op == B::Div {
                    builder.ins().sdiv(left, right)
                } else {
                    builder.ins().srem(left, right)
                }
            } else if op == B::Div {
                builder.ins().udiv(left, right)
            } else {
                builder.ins().urem(left, right)
            }
        }
        B::Shl | B::Shr => {
            if overflow {
                let invalid = builder.ins().icmp_imm_s(
                    IntCC::UnsignedGreaterThanOrEqual,
                    right,
                    i64::from(ty.bits()),
                );
                guard(builder, invalid, failure);
            }
            let right = convert(builder, right, cl_type(ty), false);
            if op == B::Shl {
                builder.ins().ishl(left, right)
            } else if ty.signed() {
                builder.ins().sshr(left, right)
            } else {
                builder.ins().ushr(left, right)
            }
        }
        B::Eq | B::Ne | B::Lt | B::Le | B::Gt | B::Ge => unreachable!(),
    })
}

fn flatten(
    bytes: &[u8],
    target: &str,
    arity: usize,
    usize_abi: bool,
    root: u32,
) -> Result<Vec<u8>, String> {
    let object = object::File::parse(bytes).map_err(|error| error.to_string())?;
    let mut text = Vec::new();
    let mut sections = HashMap::new();
    for section in object
        .sections()
        .filter(|section| section.kind() == object::SectionKind::Text)
    {
        let alignment = section.align().max(16) as usize;
        let offset = (text.len() + alignment - 1) & !(alignment - 1);
        text.resize(offset, 0xcc);
        text.extend_from_slice(section.data().map_err(|error| error.to_string())?);
        sections.insert(section.index(), offset);
    }
    if text.is_empty() || text.len() > 1024 * 1024 {
        return Err("native text budget exceeded".into());
    }
    let mut symbols = HashMap::new();
    let mut names = HashMap::new();
    for symbol in object.symbols() {
        if let Some(section) = symbol.section_index()
            && let Some(&base) = sections.get(&section)
        {
            let offset = base + symbol.address() as usize;
            if offset >= text.len() {
                return Err("native symbol is outside text".into());
            }
            symbols.insert(symbol.index(), offset);
            if let Ok(name) = symbol.name() {
                names.insert(name.to_owned(), offset);
            }
        }
    }
    for section in object.sections() {
        let Some(&base) = sections.get(&section.index()) else {
            continue;
        };
        for (offset, relocation) in section.relocations() {
            let object::RelocationTarget::Symbol(symbol) = relocation.target() else {
                return Err("non-symbol native relocation is not implemented".into());
            };
            let target = *symbols
                .get(&symbol)
                .ok_or("external symbols require the Cargo path")? as i64;
            let place = base + offset as usize;
            if relocation.size() != 32
                || !matches!(
                    relocation.kind(),
                    object::RelocationKind::Relative | object::RelocationKind::PltRelative
                )
                || place.checked_add(4).is_none_or(|end| end > text.len())
            {
                return Err("native relocation kind is not implemented".into());
            }
            let implicit = if relocation.has_implicit_addend() {
                i32::from_le_bytes(
                    text[place..place + 4]
                        .try_into()
                        .map_err(|_| "bad relocation width")?,
                ) as i64
            } else {
                0
            };
            let value: i32 = (target + relocation.addend() + implicit - place as i64)
                .try_into()
                .map_err(|_| "native relative call is out of range")?;
            text[place..place + 4].copy_from_slice(&value.to_le_bytes());
        }
    }
    let generic_entry = *names
        .get("ash_entry")
        .ok_or("generic native entry missing")?;
    let usize_entry = if usize_abi {
        Some(
            *names
                .get(&format!("ash_fn_{root}"))
                .ok_or("usize native entry missing")?,
        )
    } else {
        None
    };
    serde_json::to_vec(&machine::Image {
        version: crate::ABI_VERSION,
        target: target.into(),
        text,
        generic_entry,
        usize_entry,
        arity,
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "codegen_tests.rs"]
mod tests;
