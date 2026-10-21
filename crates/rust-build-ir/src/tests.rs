use super::*;

fn fixture() -> Program {
    Program {
        version: VERSION,
        root: 0,
        crate_root: String::new(),
        sources: vec![],
        check: CheckMode::Standalone,
        functions: vec![Function {
            name: "fixture".into(),
            source_path: String::new(),
            name_start: 0,
            exclusive: false,
            public: false,
            source: "fn fixture(value: u32) -> u32 { value }".into(),
            source_start: 0,
            body_start: 30,
            body_end: 39,
            parameters: vec![1],
            result: Scalar::U32,
            locals: vec![Scalar::U32; 3],
            blocks: vec![Block {
                statements: vec![Assign {
                    destination: 0,
                    value: Rvalue::Use {
                        operand: Operand::Local { index: 1 },
                    },
                }],
                terminator: Terminator::Return,
            }],
        }],
    }
}

#[test]
fn malformed_wire_indices_types_and_constants_are_rejected_before_codegen() {
    let program = fixture();
    validate(&program).unwrap();
    for operand in [
        Operand::Local { index: 99 },
        Operand::Constant {
            scalar: Scalar::Bool,
            bits: 2,
        },
        Operand::Constant {
            scalar: Scalar::U32,
            bits: 1u64 << 32,
        },
    ] {
        let mut invalid = program.clone();
        invalid.functions[0].blocks[0].statements[0].value = Rvalue::Use { operand };
        assert!(validate(&invalid).is_err());
    }
    let mut invalid = program.clone();
    invalid.functions[0].blocks[0].terminator = Terminator::Goto { target: 99 };
    assert!(validate(&invalid).is_err());
    let mut invalid = program;
    invalid.functions[0].parameters.push(1);
    assert!(validate(&invalid).is_err());
}

#[test]
fn a_loop_back_edge_cannot_initialize_a_value_before_its_first_read() {
    let mut program = fixture();
    let function = &mut program.functions[0];
    function.blocks = vec![
        Block {
            statements: vec![],
            terminator: Terminator::Goto { target: 1 },
        },
        Block {
            statements: vec![Assign {
                destination: 0,
                value: Rvalue::Use {
                    operand: Operand::Local { index: 2 },
                },
            }],
            terminator: Terminator::Goto { target: 2 },
        },
        Block {
            statements: vec![Assign {
                destination: 2,
                value: Rvalue::Use {
                    operand: Operand::Local { index: 1 },
                },
            }],
            terminator: Terminator::Goto { target: 1 },
        },
    ];
    assert!(validate(&program).unwrap_err().contains("uninitialized"));
    program.functions[0].blocks[0].statements.push(Assign {
        destination: 2,
        value: Rvalue::Use {
            operand: Operand::Local { index: 1 },
        },
    });
    validate(&program).unwrap();
}

#[test]
fn recursive_call_graphs_are_rejected_without_entering_native_code() {
    let mut program = fixture();
    program.functions[0].blocks[0].terminator = Terminator::Call {
        function: 0,
        arguments: vec![Operand::Local { index: 1 }],
        destination: 2,
        target: 0,
    };
    assert!(validate(&program).unwrap_err().contains("recursive"));
}

#[test]
fn source_origins_reject_path_escape_and_ranges_from_a_different_revision() {
    let mut program = fixture();
    let function = &mut program.functions[0];
    function.source_path = "src/lib.rs".into();
    function.name_start = 3;
    function.body_start = function.source.find('{').unwrap() as u32;
    function.body_end = function.source.len() as u32;
    program.sources = vec![Source {
        path: function.source_path.clone(),
        text: function.source.clone(),
    }];
    validate(&program).unwrap();
    program.sources[0].text.push(' ');
    validate(&program).unwrap();
    program.sources[0].text.replace_range(..2, "xx");
    assert!(validate(&program).unwrap_err().contains("snapshot"));
    program.sources[0].path = "../escape.rs".into();
    assert!(validate(&program).unwrap_err().contains("source snapshot"));
}
