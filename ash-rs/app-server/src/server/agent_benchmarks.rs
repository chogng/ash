use agent::resolve_agent_selection;
use agent_roles::AgentRoleCatalog;
use ash_protocol::AgentRoleSelection;
use ash_protocol::AgentRoleSource;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ToolName;
use std::hint::black_box;
use std::time::Instant;

fn measure<T>(name: &str, role_count: usize, tool_count: usize, mut operation: impl FnMut() -> T) {
    const SAMPLES: usize = 1000;
    const BATCH: usize = 10;
    for _ in 0..100 {
        black_box(operation());
    }
    let mut times = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let started = Instant::now();
        for _ in 0..BATCH {
            black_box(operation());
        }
        times.push((started.elapsed().as_nanos() / BATCH as u128) as u64);
    }
    let raw = times.clone();
    times.sort_unstable();
    println!(
        "{}",
        serde_json::json!({"benchmark":name,"role_count":role_count,"tool_count":tool_count,"samples":SAMPLES,"samples_ns":raw,"batch":BATCH,"warmup":100,"p50_ns":times[SAMPLES/2],"p95_ns":times[SAMPLES*95/100],"p99_ns":times[SAMPLES*99/100],"debug_assertions":cfg!(debug_assertions),"network":false})
    );
}

#[test]
#[ignore = "offline instruction benchmark; run explicitly with --ignored --nocapture --test-threads=1"]
fn instruction_benchmark_selection() {
    let model = ModelRef::new(
        ProviderId::new("benchmark").unwrap(),
        ModelId::new("model").unwrap(),
    );
    let profiles = ash_models_manager::ModelInstructionCatalog::new([
        ash_models_manager::ModelInstructionProfile {
            model: model.clone(),
            instructions: ash_prompts::PromptArtifact::new(
                "models-manager",
                "benchmark/guidance",
                "v1",
                ash_prompts::AGENT_INSTRUCTIONS.body(),
            ),
        },
    ])
    .unwrap();
    measure("model_instruction_lookup", 1, 0, || {
        profiles.resolve(Some(&model))
    });
    for (role_count, tool_count) in [(1, 128), (16, 128), (128, 128), (16, 16), (16, 512)] {
        let mut directories = Vec::new();
        let mut catalogs = Vec::new();
        for first in (0..role_count).step_by(64) {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join(".ash/agents");
            std::fs::create_dir_all(&root).unwrap();
            for index in first..(first + 64).min(role_count) {
                std::fs::write(
                    root.join(format!("role-{index}.md")),
                    format!(
                        "---\nname: role-{index}\ndescription: Benchmark role.\n---\n{}\n",
                        "x".repeat(2048)
                    ),
                )
                .unwrap();
            }
            catalogs.push(
                AgentRoleCatalog::discover(format!("benchmark-{}", first / 64), directory.path())
                    .snapshot(),
            );
            directories.push(directory);
        }
        assert_eq!(
            catalogs
                .iter()
                .map(|catalog| catalog.entries().len())
                .sum::<usize>(),
            role_count
        );
        let tools = (0..tool_count)
            .map(|index| ToolName::new(format!("tool_{index}")).unwrap())
            .collect::<Vec<_>>();
        let selected = AgentRoleSelection::Exact {
            source: AgentRoleSource::Directory {
                id: format!("benchmark-{}", (role_count - 1) / 64),
            },
            name: format!("role-{}", role_count - 1),
        };
        measure("default_role", role_count, tool_count, || {
            resolve_agent_selection(
                &AgentRoleSelection::Default,
                Some(&model),
                tools.clone(),
                &[],
                &catalogs,
                &[],
            )
            .unwrap()
        });
        measure("exact_role", role_count, tool_count, || {
            resolve_agent_selection(&selected, Some(&model), tools.clone(), &[], &catalogs, &[])
                .unwrap()
        });
    }
}
