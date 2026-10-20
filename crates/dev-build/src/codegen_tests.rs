use super::*;
use crate::machine::Code;

#[test]
fn published_code_reloads_atomically_and_rejected_images_keep_the_previous_mapping() {
    let directory = tempfile::tempdir().unwrap();
    let mut program = program(mir::Scalar::Usize, mir::Binary::Add);
    let function = &mut program.functions[0];
    function.parameters = vec![1];
    function.blocks[0].statements[0].value = mir::Rvalue::Binary {
        op: mir::Binary::Add,
        left: mir::Operand::Local { index: 1 },
        right: mir::Operand::Constant {
            scalar: mir::Scalar::Usize,
            bits: 1,
        },
    };
    let bytes = compile(&program, true).unwrap();
    crate::build::publish(
        directory.path(),
        &bytes,
        crate::reload::ImageKind::UsizeCode,
    )
    .unwrap();
    let module = crate::ReloadableModule::new_usize(directory.path().to_path_buf());
    let old = module.usize_function().unwrap();
    assert_eq!(old.call(30).unwrap(), 31);
    program.functions[0].blocks[0].statements[0].value = mir::Rvalue::Binary {
        op: mir::Binary::Sub,
        left: mir::Operand::Local { index: 1 },
        right: mir::Operand::Constant {
            scalar: mir::Scalar::Usize,
            bits: 1,
        },
    };
    let bytes = compile(&program, true).unwrap();
    crate::build::publish(
        directory.path(),
        &bytes,
        crate::reload::ImageKind::UsizeCode,
    )
    .unwrap();
    assert_eq!(module.usize_function().unwrap().call(30).unwrap(), 29);
    assert_eq!(old.call(30).unwrap(), 31);
    std::fs::write(
        directory.path().join("current.json"),
        br#"{"version":1,"sha256":"invalid","kind":"usize_code"}"#,
    )
    .unwrap();
    assert_eq!(module.usize_function().unwrap().call(30).unwrap(), 29);
    let mut image: crate::machine::Image = serde_json::from_slice(&bytes).unwrap();
    image.generic_entry = image.text.len();
    assert!(Code::load(&serde_json::to_vec(&image).unwrap()).is_err());
    image.generic_entry = 0;
    image.target = "wrong-target".into();
    assert!(Code::load(&serde_json::to_vec(&image).unwrap()).is_err());
}

#[test]
fn rustc_gate_rejects_semantically_invalid_source_even_when_scalar_ir_is_well_formed() {
    let directory = tempfile::tempdir().unwrap();
    let mut program = program(mir::Scalar::Usize, mir::Binary::Add);
    program.functions[0].source =
        "fn scalar(a: usize, b: usize) -> usize { let x = a; x = b; x }".into();
    assert!(
        !crate::jit::check(
            directory.path(),
            directory.path(),
            &program,
            &mut crate::check::Checker::default()
        )
        .unwrap()
    );
    program.functions[0].source =
        "fn scalar(a: usize, b: usize) -> usize { let mut x = a; x += b; x }".into();
    assert!(
        crate::jit::check(
            directory.path(),
            directory.path(),
            &program,
            &mut crate::check::Checker::default()
        )
        .unwrap()
    );
}

fn program(ty: mir::Scalar, op: mir::Binary) -> mir::Program {
    let comparison = matches!(
        op,
        mir::Binary::Eq
            | mir::Binary::Ne
            | mir::Binary::Lt
            | mir::Binary::Le
            | mir::Binary::Gt
            | mir::Binary::Ge
    );
    let result = if comparison { mir::Scalar::Bool } else { ty };
    mir::Program {
        version: mir::VERSION,
        root: 0,
        crate_root: String::new(),
        sources: vec![],
        check: mir::CheckMode::Standalone,
        functions: vec![mir::Function {
            name: "scalar".into(),
            source_path: String::new(),
            name_start: 0,
            exclusive: false,
            public: false,
            source: "fn scalar() {}".into(),
            source_start: 0,
            body_start: 1,
            body_end: 2,
            parameters: vec![1, 2],
            result,
            locals: vec![result, ty, ty],
            blocks: vec![mir::Block {
                statements: vec![mir::Assign {
                    destination: 0,
                    value: mir::Rvalue::Binary {
                        op,
                        left: mir::Operand::Local { index: 1 },
                        right: mir::Operand::Local { index: 2 },
                    },
                }],
                terminator: mir::Terminator::Return,
            }],
        }],
    }
}

#[test]
fn generated_unsigned_arithmetic_matches_rust_and_returns_status_for_panics() {
    use mir::Binary as B;
    for ty in [
        mir::Scalar::U8,
        mir::Scalar::U16,
        mir::Scalar::U32,
        mir::Scalar::U64,
        mir::Scalar::Usize,
    ] {
        let mask = u64::MAX >> (64 - ty.bits());
        for op in [
            B::Add,
            B::Sub,
            B::Mul,
            B::Div,
            B::Rem,
            B::DivCeil,
            B::Shl,
            B::Shr,
            B::And,
            B::Or,
            B::Xor,
            B::Eq,
            B::Lt,
            B::WrappingAdd,
            B::WrappingSub,
            B::WrappingMul,
            B::SaturatingAdd,
            B::SaturatingSub,
            B::SaturatingMul,
        ] {
            let image = compile(&program(ty, op), true)
                .unwrap_or_else(|error| panic!("{ty:?} {op:?}: {error}"));
            let code = Code::load(&image).unwrap();
            for (left, right) in [
                (0, 0),
                (0, 1),
                (1, 0),
                (3, 2),
                (mask, 1),
                (mask, mask),
                (1, u64::from(ty.bits())),
                (mask >> 1, 2),
            ] {
                let expected = match op {
                    B::Add => left.checked_add(right).filter(|value| *value <= mask),
                    B::Sub => left.checked_sub(right),
                    B::Mul => left.checked_mul(right).filter(|value| *value <= mask),
                    B::Div => left.checked_div(right),
                    B::Rem => left.checked_rem(right),
                    B::DivCeil => left
                        .checked_div(right)
                        .map(|quotient| quotient + u64::from(left % right != 0)),
                    B::Shl => (right < u64::from(ty.bits())).then(|| (left << right) & mask),
                    B::Shr => (right < u64::from(ty.bits())).then(|| left >> right),
                    B::And => Some(left & right),
                    B::Or => Some(left | right),
                    B::Xor => Some(left ^ right),
                    B::Eq => Some(u64::from(left == right)),
                    B::Lt => Some(u64::from(left < right)),
                    B::WrappingAdd => Some(left.wrapping_add(right) & mask),
                    B::WrappingSub => Some(left.wrapping_sub(right) & mask),
                    B::WrappingMul => Some(left.wrapping_mul(right) & mask),
                    B::SaturatingAdd => Some(left.saturating_add(right).min(mask)),
                    B::SaturatingSub => Some(left.saturating_sub(right)),
                    B::SaturatingMul => Some(left.saturating_mul(right).min(mask)),
                    _ => unreachable!(),
                };
                assert_eq!(
                    code.call(&[left, right]).ok(),
                    expected,
                    "{ty:?} {op:?} {left} {right}"
                );
            }
        }
    }
}

#[test]
fn generated_signed_operations_match_rust_at_width_boundaries() {
    use mir::Binary as B;
    for ty in [
        mir::Scalar::I8,
        mir::Scalar::I16,
        mir::Scalar::I32,
        mir::Scalar::I64,
        mir::Scalar::Isize,
    ] {
        let mask = u64::MAX >> (64 - ty.bits());
        let min = -(1i128 << (ty.bits() - 1));
        let max = (1i128 << (ty.bits() - 1)) - 1;
        for op in [
            B::Add,
            B::Sub,
            B::Mul,
            B::Div,
            B::Rem,
            B::SaturatingAdd,
            B::SaturatingSub,
            B::SaturatingMul,
            B::Lt,
            B::Ge,
        ] {
            let image = compile(&program(ty, op), true)
                .unwrap_or_else(|error| panic!("{ty:?} {op:?}: {error}"));
            let code = Code::load(&image).unwrap();
            for (left, right) in [
                (0, 0),
                (-3, 2),
                (3, -2),
                (min, -1),
                (min, 1),
                (max, 1),
                (max, max),
                (-1, min),
            ] {
                let signed = match op {
                    B::Add => Some(left + right),
                    B::Sub => Some(left - right),
                    B::Mul => Some(left * right),
                    B::Div => {
                        if right == 0 || left == min && right == -1 {
                            None
                        } else {
                            Some(left / right)
                        }
                    }
                    B::Rem => {
                        if right == 0 || left == min && right == -1 {
                            None
                        } else {
                            Some(left % right)
                        }
                    }
                    B::SaturatingAdd => Some((left + right).clamp(min, max)),
                    B::SaturatingSub => Some((left - right).clamp(min, max)),
                    B::SaturatingMul => Some((left * right).clamp(min, max)),
                    B::Lt => Some(i128::from(left < right)),
                    B::Ge => Some(i128::from(left >= right)),
                    _ => unreachable!(),
                }
                .filter(|value| *value >= min && *value <= max)
                .map(|value| value as u64 & mask);
                assert_eq!(
                    code.call(&[left as u64 & mask, right as u64 & mask]).ok(),
                    signed,
                    "{ty:?} {op:?} {left} {right}"
                );
            }
        }
    }
}

#[test]
fn direct_function_relocations_work_and_images_remain_callable_across_replacement() {
    let mut graph = program(mir::Scalar::Usize, mir::Binary::Add);
    let helper = graph.functions[0].clone();
    graph.functions[0].blocks = vec![
        mir::Block {
            statements: vec![],
            terminator: mir::Terminator::Call {
                function: 1,
                arguments: vec![
                    mir::Operand::Local { index: 1 },
                    mir::Operand::Local { index: 2 },
                ],
                destination: 0,
                target: 1,
            },
        },
        mir::Block {
            statements: vec![],
            terminator: mir::Terminator::Return,
        },
    ];
    graph.functions.push(helper);
    let first = Code::load(&compile(&graph, true).unwrap()).unwrap();
    assert_eq!(first.call(&[20, 22]).unwrap(), 42);
    graph.functions[1].blocks[0].statements[0].value = mir::Rvalue::Binary {
        op: mir::Binary::Sub,
        left: mir::Operand::Local { index: 1 },
        right: mir::Operand::Local { index: 2 },
    };
    let next = Code::load(&compile(&graph, true).unwrap()).unwrap();
    assert_eq!(next.call(&[20, 2]).unwrap(), 18);
    assert_eq!(first.call(&[20, 22]).unwrap(), 42);
    assert!(next.call(&[1, 2]).is_err());
}
