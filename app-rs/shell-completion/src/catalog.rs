use crate::registry::ShellArgumentSpec;
use crate::registry::ShellChoice;
use crate::registry::ShellCommandRegistry;
use crate::registry::ShellCommandSpec;
use crate::registry::ShellOptionSpec;

mod standard;

pub(crate) fn default_registry() -> ShellCommandRegistry {
    let mut registry = ShellCommandRegistry::new();
    for command in standard::shell_builtins() {
        registry.register(command);
    }
    for command in standard::unix_commands() {
        registry.register(command);
    }
    for command in [
        echo(),
        git(),
        cargo(),
        docker(),
        kubectl(),
        npm(),
        pnpm(),
        yarn(),
        bun(),
        python("python"),
        python("python3"),
        rg(),
        find(),
        curl(),
    ]
    .into_iter()
    .map(ShellCommandSpec::requiring_executable)
    {
        registry.register(command);
    }
    registry
}

fn git() -> ShellCommandSpec {
    let mut git = flat_subcommands(
        "git",
        "Distributed version control",
        &[
            ("add", "Add file contents to the index"),
            ("bisect", "Find a change by binary search"),
            ("branch", "List or manage branches"),
            ("checkout", "Switch branches or restore files"),
            ("clone", "Clone a repository"),
            ("commit", "Record changes"),
            ("config", "Read or write Git configuration"),
            ("diff", "Show changes"),
            ("fetch", "Download refs and objects"),
            ("grep", "Search tracked content"),
            ("init", "Create a repository"),
            ("log", "Show commit history"),
            ("merge", "Join development histories"),
            ("mv", "Move or rename a path"),
            ("pull", "Fetch and integrate changes"),
            ("push", "Update remote refs"),
            ("rebase", "Reapply commits"),
            ("remote", "Manage remotes"),
            ("reset", "Reset the current HEAD"),
            ("restore", "Restore working tree files"),
            ("revert", "Create commits that revert changes"),
            ("rm", "Remove tracked files"),
            ("show", "Show Git objects"),
            ("stash", "Stash working tree changes"),
            ("status", "Show working tree status"),
            ("switch", "Switch branches"),
            ("tag", "Create or list tags"),
            ("worktree", "Manage linked working trees"),
        ],
    );
    git = git
        .with_option(value(
            ["-C"],
            ShellArgumentSpec::directory("path"),
            "Run as if started in path",
        ))
        .with_option(value(
            ["-c"],
            ShellArgumentSpec::opaque("setting"),
            "Set configuration",
        ))
        .with_subcommand(
            ShellCommandSpec::new("checkout", "Switch branches or restore files")
                .with_option(value(
                    ["-b"],
                    ShellArgumentSpec::opaque("branch"),
                    "Create and switch to a branch",
                ))
                .with_option(flag(["--detach"], "Detach HEAD"))
                .with_argument(ShellArgumentSpec::opaque("branch-or-path").repeated()),
        )
        .with_subcommand(
            ShellCommandSpec::new("log", "Show commit history")
                .with_option(flag(["--oneline"], "Show one commit per line"))
                .with_option(flag(["--decorate"], "Show ref names"))
                .with_option(flag(["--graph"], "Draw the commit graph"))
                .with_option(value(
                    ["-n", "--max-count"],
                    ShellArgumentSpec::integer("count"),
                    "Limit commit count",
                ))
                .with_argument(ShellArgumentSpec::opaque("revision-or-path").repeated()),
        )
        .with_subcommand(
            ShellCommandSpec::new("commit", "Record changes")
                .with_option(value(
                    ["-m", "--message"],
                    ShellArgumentSpec::opaque("message"),
                    "Commit message",
                ))
                .with_option(flag(["-a", "--all"], "Stage modified and deleted files"))
                .with_option(flag(["--amend"], "Amend the previous commit")),
        );
    git
}

fn cargo() -> ShellCommandSpec {
    flat_subcommands(
        "cargo",
        "Rust package manager",
        &[
            ("add", "Add dependencies"),
            ("bench", "Run benchmarks"),
            ("build", "Compile packages"),
            ("check", "Check packages without producing binaries"),
            ("clean", "Remove generated artifacts"),
            ("clippy", "Run Clippy"),
            ("doc", "Build documentation"),
            ("fetch", "Fetch dependencies"),
            ("fix", "Automatically fix warnings"),
            ("fmt", "Format Rust code"),
            ("generate-lockfile", "Generate Cargo.lock"),
            ("install", "Install Rust binaries"),
            ("metadata", "Emit package metadata"),
            ("new", "Create a package"),
            ("publish", "Upload a package"),
            ("remove", "Remove dependencies"),
            ("run", "Run a binary"),
            ("search", "Search the registry"),
            ("test", "Run tests"),
            ("tree", "Display dependency trees"),
            ("update", "Update dependencies"),
        ],
    )
    .with_option(flag(["-q", "--quiet"], "Suppress Cargo output"))
    .with_option(flag(["-v", "--verbose"], "Use verbose output"))
    .with_option(value(
        ["--manifest-path"],
        ShellArgumentSpec::file("manifest"),
        "Cargo.toml path",
    ))
    .with_subcommand(cargo_build_command("build", "Compile packages"))
    .with_subcommand(cargo_build_command(
        "check",
        "Check packages without producing binaries",
    ))
    .with_subcommand(cargo_build_command("test", "Run tests"))
}

fn cargo_build_command(name: &str, description: &str) -> ShellCommandSpec {
    ShellCommandSpec::new(name, description)
        .with_option(flag(["--release"], "Build optimized artifacts"))
        .with_option(flag(["--workspace"], "Use all workspace packages"))
        .with_option(value(
            ["-p", "--package"],
            ShellArgumentSpec::opaque("package"),
            "Select a package",
        ))
        .with_option(value(
            ["-j", "--jobs"],
            ShellArgumentSpec::integer("jobs"),
            "Parallel jobs",
        ))
        .with_argument(ShellArgumentSpec::opaque("target").repeated())
}

fn docker() -> ShellCommandSpec {
    let compose = flat_subcommands(
        "compose",
        "Manage multi-container applications",
        &[
            ("build", "Build services"),
            ("config", "Parse and render the Compose file"),
            ("cp", "Copy files between services and the local filesystem"),
            ("down", "Stop and remove services"),
            ("exec", "Run a command in a running container"),
            ("images", "List service images"),
            ("logs", "View service output"),
            ("ls", "List Compose projects"),
            ("ps", "List service containers"),
            ("pull", "Pull service images"),
            ("restart", "Restart services"),
            ("run", "Run a one-off command"),
            ("start", "Start services"),
            ("stop", "Stop services"),
            ("up", "Create and start services"),
        ],
    )
    .with_option(value(
        ["-f", "--file"],
        ShellArgumentSpec::file("compose-file"),
        "Compose file",
    ))
    .with_option(value(
        ["-p", "--project-name"],
        ShellArgumentSpec::opaque("name"),
        "Project name",
    ))
    .with_subcommand(
        ShellCommandSpec::new("up", "Create and start services")
            .with_option(flag(["-d", "--detach"], "Run in the background"))
            .with_option(flag(["--build"], "Build images before starting"))
            .with_option(flag(["--force-recreate"], "Recreate containers"))
            .with_argument(ShellArgumentSpec::opaque("service").repeated()),
    );
    flat_subcommands(
        "docker",
        "Build and run containers",
        &[
            ("build", "Build an image"),
            ("commit", "Create an image from a container"),
            ("container", "Manage containers"),
            ("context", "Manage contexts"),
            (
                "cp",
                "Copy files between containers and the local filesystem",
            ),
            ("create", "Create a container"),
            ("exec", "Run a command in a container"),
            ("image", "Manage images"),
            ("images", "List images"),
            ("info", "Display system information"),
            ("inspect", "Return low-level object information"),
            ("kill", "Kill containers"),
            ("logs", "Fetch container logs"),
            ("network", "Manage networks"),
            ("ps", "List containers"),
            ("pull", "Pull an image"),
            ("push", "Push an image"),
            ("restart", "Restart containers"),
            ("rm", "Remove containers"),
            ("rmi", "Remove images"),
            ("run", "Run a command in a new container"),
            ("start", "Start containers"),
            ("stop", "Stop containers"),
            ("system", "Manage Docker"),
            ("volume", "Manage volumes"),
        ],
    )
    .with_subcommand(compose)
}

fn kubectl() -> ShellCommandSpec {
    flat_subcommands(
        "kubectl",
        "Control Kubernetes clusters",
        &[
            ("annotate", "Update resource annotations"),
            ("api-resources", "List supported API resources"),
            ("apply", "Apply a configuration"),
            ("attach", "Attach to a container"),
            ("auth", "Inspect authorization"),
            ("cluster-info", "Display cluster information"),
            ("config", "Modify kubeconfig files"),
            ("create", "Create a resource"),
            ("delete", "Delete resources"),
            ("describe", "Show resource details"),
            ("diff", "Diff live state against configuration"),
            ("edit", "Edit a resource"),
            ("exec", "Run a command in a container"),
            ("explain", "Show resource documentation"),
            ("get", "Display resources"),
            ("label", "Update resource labels"),
            ("logs", "Print container logs"),
            ("patch", "Update fields of a resource"),
            ("port-forward", "Forward local ports"),
            ("rollout", "Manage rollouts"),
            ("scale", "Set a new size for a workload"),
            ("top", "Display resource usage"),
            ("version", "Print client and server versions"),
            ("wait", "Wait for a resource condition"),
        ],
    )
    .with_option(value(
        ["-n", "--namespace"],
        ShellArgumentSpec::opaque("namespace"),
        "Namespace",
    ))
    .with_option(value(
        ["--context"],
        ShellArgumentSpec::opaque("context"),
        "Kubeconfig context",
    ))
    .with_option(value(
        ["-f", "--filename"],
        ShellArgumentSpec::path("file"),
        "Resource file",
    ))
    .with_subcommand(
        ShellCommandSpec::new("get", "Display resources")
            .with_option(value(
                ["-n", "--namespace"],
                ShellArgumentSpec::opaque("namespace"),
                "Namespace",
            ))
            .with_option(value(
                ["-o", "--output"],
                ShellArgumentSpec::opaque("format"),
                "Output format",
            ))
            .with_option(flag(["-A", "--all-namespaces"], "Use all namespaces"))
            .with_argument(ShellArgumentSpec::opaque("resource").repeated()),
    )
}

fn echo() -> ShellCommandSpec {
    ShellCommandSpec::new("echo", "Write arguments to standard output")
        .with_option(flag(["-n"], "Do not write a trailing newline"))
        .with_option(flag(["-e"], "Enable backslash escapes"))
        .with_argument(ShellArgumentSpec::opaque("text").repeated())
}

fn npm() -> ShellCommandSpec {
    flat_subcommands(
        "npm",
        "Node package manager",
        &[
            ("ci", "Install from a lockfile"),
            ("exec", "Run a package binary"),
            ("init", "Create package.json"),
            ("install", "Install packages"),
            ("link", "Symlink a package"),
            ("list", "List installed packages"),
            ("outdated", "Check for outdated packages"),
            ("publish", "Publish a package"),
            ("run", "Run a package script"),
            ("start", "Run the start script"),
            ("test", "Run the test script"),
            ("uninstall", "Remove packages"),
            ("update", "Update packages"),
        ],
    )
}

fn pnpm() -> ShellCommandSpec {
    package_manager("pnpm", "Fast disk-efficient package manager")
}

fn yarn() -> ShellCommandSpec {
    package_manager("yarn", "JavaScript package manager")
}

fn bun() -> ShellCommandSpec {
    package_manager("bun", "JavaScript runtime and package manager")
}

fn package_manager(name: &str, description: &str) -> ShellCommandSpec {
    flat_subcommands(
        name,
        description,
        &[
            ("add", "Add dependencies"),
            ("build", "Run the build script"),
            ("exec", "Run a package binary"),
            ("install", "Install dependencies"),
            ("remove", "Remove dependencies"),
            ("run", "Run a package script"),
            ("test", "Run tests"),
            ("update", "Update dependencies"),
        ],
    )
}

fn python(name: &str) -> ShellCommandSpec {
    ShellCommandSpec::new(name, "Python interpreter")
        .with_option(value(
            ["-c"],
            ShellArgumentSpec::opaque("code"),
            "Execute Python code",
        ))
        .with_option(value(
            ["-m"],
            ShellArgumentSpec::command("module"),
            "Run a library module",
        ))
        .with_argument(ShellArgumentSpec::file("script"))
}

fn rg() -> ShellCommandSpec {
    ShellCommandSpec::new("rg", "Recursively search files with ripgrep")
        .with_option(value(
            ["-g", "--glob"],
            ShellArgumentSpec::opaque("glob"),
            "Include or exclude paths",
        ))
        .with_option(value(
            ["-t", "--type"],
            ShellArgumentSpec::opaque("type"),
            "Search a file type",
        ))
        .with_option(flag(["-n", "--line-number"], "Show line numbers"))
        .with_option(flag(["-i", "--ignore-case"], "Ignore letter case"))
        .with_option(flag(
            ["-F", "--fixed-strings"],
            "Treat the pattern literally",
        ))
        .with_argument(ShellArgumentSpec::opaque("pattern"))
        .with_argument(ShellArgumentSpec::path("path").repeated())
}

fn find() -> ShellCommandSpec {
    ShellCommandSpec::new("find", "Search directory trees")
        .with_argument(ShellArgumentSpec::path("starting-point").repeated())
        .with_option(value(
            ["-name"],
            ShellArgumentSpec::opaque("pattern"),
            "Match file name",
        ))
        .with_option(value(
            ["-type"],
            choices("kind", &["f", "d", "l"]),
            "Match file type",
        ))
        .with_option(flag(["-print"], "Print matching paths"))
        .with_option(value(
            ["-maxdepth"],
            ShellArgumentSpec::integer("levels"),
            "Maximum depth",
        ))
}

fn curl() -> ShellCommandSpec {
    ShellCommandSpec::new("curl", "Transfer data from URLs")
        .with_option(value(
            ["-X", "--request"],
            choices("method", &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
            "HTTP method",
        ))
        .with_option(value(
            ["-H", "--header"],
            ShellArgumentSpec::opaque("header"),
            "Request header",
        ))
        .with_option(value(
            ["-d", "--data"],
            ShellArgumentSpec::opaque("data"),
            "Request body",
        ))
        .with_option(value(
            ["-o", "--output"],
            ShellArgumentSpec::path("file"),
            "Output path",
        ))
        .with_option(flag(["-L", "--location"], "Follow redirects"))
        .with_argument(ShellArgumentSpec::opaque("url"))
}

fn flat_subcommands(
    name: &str,
    description: &str,
    subcommands: &[(&str, &str)],
) -> ShellCommandSpec {
    subcommands.iter().fold(
        ShellCommandSpec::new(name, description),
        |command, (subcommand, subcommand_description)| {
            command.with_subcommand(ShellCommandSpec::new(*subcommand, *subcommand_description))
        },
    )
}

fn flag<const N: usize>(names: [&str; N], description: &str) -> ShellOptionSpec {
    ShellOptionSpec::flag(names, description)
}

fn value<const N: usize>(
    names: [&str; N],
    argument: ShellArgumentSpec,
    description: &str,
) -> ShellOptionSpec {
    ShellOptionSpec::value(names, argument, description)
}

fn choices(name: &str, values: &[&str]) -> ShellArgumentSpec {
    ShellArgumentSpec::choices(name, values.iter().map(|value| ShellChoice::new(*value)))
}
