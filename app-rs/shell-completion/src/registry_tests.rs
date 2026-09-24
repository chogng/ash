use super::ShellArgumentSpec;
use super::ShellCommandRegistry;
use super::ShellCommandSpec;
use super::ShellOptionSpec;

#[test]
fn registry_preserves_recursive_command_grammar() {
    let mut registry = ShellCommandRegistry::new();
    registry.register(
        ShellCommandSpec::new("tool", "Tool")
            .with_option(ShellOptionSpec::flag(["-v", "--verbose"], "Verbose"))
            .with_subcommand(
                ShellCommandSpec::new("run", "Run a target")
                    .with_argument(ShellArgumentSpec::path("target")),
            ),
    );

    let tool = registry.command("tool").unwrap();
    assert_eq!(tool.option("--verbose").unwrap().primary_name(), "-v");
    let run = tool.subcommand("run").unwrap();
    assert_eq!(run.arguments()[0].name(), "target");
}
