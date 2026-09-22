use super::flag;
use super::value;
use crate::registry::ShellArgumentSpec;
use crate::registry::ShellCommandSpec;

pub(super) fn shell_builtins() -> Vec<ShellCommandSpec> {
    [
        (".", "Execute a file in the current shell"),
        ("alias", "Define or display shell aliases"),
        ("bg", "Resume a job in the background"),
        ("bind", "Configure shell key bindings"),
        ("break", "Exit a shell loop"),
        ("builtin", "Run a shell builtin"),
        ("cd", "Change the working directory"),
        ("command", "Run a command without shell function lookup"),
        ("continue", "Continue a shell loop"),
        ("declare", "Declare shell variables"),
        ("dirs", "Display the directory stack"),
        ("disown", "Remove jobs from the shell job table"),
        ("echo", "Write arguments to standard output"),
        ("enable", "Enable or disable shell builtins"),
        ("eval", "Evaluate arguments as shell input"),
        ("exec", "Replace the shell with a command"),
        ("exit", "Exit the shell"),
        ("export", "Export shell variables"),
        ("false", "Return an unsuccessful status"),
        ("fg", "Resume a job in the foreground"),
        ("fc", "List or edit commands from shell history"),
        ("getopts", "Parse positional command options"),
        ("hash", "Manage remembered command locations"),
        ("help", "Display help for shell builtins"),
        ("history", "Display or modify command history"),
        ("jobs", "List shell jobs"),
        ("kill", "Send a signal to a process"),
        ("let", "Evaluate shell arithmetic"),
        ("local", "Declare a local shell variable"),
        ("logout", "Exit a login shell"),
        ("mapfile", "Read lines into an indexed array"),
        ("popd", "Remove a directory from the directory stack"),
        ("printf", "Format and print data"),
        ("pushd", "Add a directory to the directory stack"),
        ("pwd", "Print the working directory"),
        ("read", "Read a line into shell variables"),
        ("readonly", "Mark shell variables as read-only"),
        ("return", "Return from a shell function"),
        ("set", "Set shell options and positional parameters"),
        ("shift", "Shift shell positional parameters"),
        ("shopt", "Set optional shell behavior"),
        ("source", "Execute a file in the current shell"),
        ("suspend", "Suspend the current shell"),
        ("test", "Evaluate a conditional expression"),
        ("times", "Display process execution times"),
        ("trap", "Install signal handlers"),
        ("true", "Return a successful status"),
        ("type", "Describe how a command name resolves"),
        ("typeset", "Declare shell variables and attributes"),
        ("ulimit", "Set shell resource limits"),
        ("umask", "Set the file creation mask"),
        ("unalias", "Remove shell aliases"),
        ("unset", "Remove shell variables or functions"),
        ("wait", "Wait for a process or job"),
    ]
    .into_iter()
    .map(|(name, description)| ShellCommandSpec::new(name, description))
    .collect()
}

pub(super) fn unix_commands() -> Vec<ShellCommandSpec> {
    let path = ShellArgumentSpec::path("path").repeated();
    let directory = ShellArgumentSpec::directory("directory").repeated();
    let file = ShellArgumentSpec::file("file").repeated();
    vec![
        ShellCommandSpec::new("ls", "List directory contents")
            .with_option(flag(["-a", "--all"], "Include hidden entries"))
            .with_option(flag(["-l"], "Use the long listing format"))
            .with_option(flag(["-h", "--human-readable"], "Use readable sizes"))
            .with_argument(path.clone()),
        ShellCommandSpec::new("cat", "Concatenate files").with_argument(file.clone()),
        ShellCommandSpec::new("head", "Print the beginning of files")
            .with_option(value(
                ["-n", "--lines"],
                ShellArgumentSpec::integer("count"),
                "Line count",
            ))
            .with_argument(file.clone()),
        ShellCommandSpec::new("tail", "Print the end of files")
            .with_option(value(
                ["-n", "--lines"],
                ShellArgumentSpec::integer("count"),
                "Line count",
            ))
            .with_option(flag(["-f", "--follow"], "Follow appended data"))
            .with_argument(file.clone()),
        ShellCommandSpec::new("less", "Page through text").with_argument(file.clone()),
        ShellCommandSpec::new("cp", "Copy files and directories").with_argument(path.clone()),
        ShellCommandSpec::new("mv", "Move files and directories").with_argument(path.clone()),
        ShellCommandSpec::new("rm", "Remove files and directories")
            .with_option(flag(
                ["-r", "-R", "--recursive"],
                "Remove directories recursively",
            ))
            .with_option(flag(["-f", "--force"], "Ignore missing files"))
            .with_argument(path.clone()),
        ShellCommandSpec::new("mkdir", "Create directories")
            .with_option(flag(["-p", "--parents"], "Create parent directories"))
            .with_argument(directory.clone()),
        ShellCommandSpec::new("touch", "Create files or update timestamps")
            .with_argument(path.clone()),
        ShellCommandSpec::new("ln", "Create links").with_argument(path.clone()),
        ShellCommandSpec::new("chmod", "Change file modes")
            .with_argument(ShellArgumentSpec::opaque("mode"))
            .with_argument(path.clone()),
        ShellCommandSpec::new("chown", "Change file ownership")
            .with_argument(ShellArgumentSpec::opaque("owner"))
            .with_argument(path.clone()),
        ShellCommandSpec::new("grep", "Search text by pattern")
            .with_option(flag(["-n", "--line-number"], "Show line numbers"))
            .with_option(flag(["-r", "-R", "--recursive"], "Search recursively"))
            .with_option(flag(["-i", "--ignore-case"], "Ignore letter case"))
            .with_argument(ShellArgumentSpec::opaque("pattern"))
            .with_argument(path.clone()),
        ShellCommandSpec::new("sed", "Transform text streams")
            .with_argument(ShellArgumentSpec::opaque("program"))
            .with_argument(file.clone()),
        ShellCommandSpec::new("awk", "Process text with an AWK program")
            .with_argument(ShellArgumentSpec::opaque("program"))
            .with_argument(file.clone()),
        ShellCommandSpec::new("tar", "Create or extract archives")
            .with_option(value(
                ["-f", "--file"],
                ShellArgumentSpec::path("archive"),
                "Archive path",
            ))
            .with_option(flag(["-x", "--extract"], "Extract an archive"))
            .with_option(flag(["-c", "--create"], "Create an archive"))
            .with_argument(path.clone()),
        ShellCommandSpec::new("ssh", "Connect to a remote host")
            .with_option(value(
                ["-p"],
                ShellArgumentSpec::integer("port"),
                "Remote port",
            ))
            .with_option(value(
                ["-i"],
                ShellArgumentSpec::file("identity"),
                "Identity file",
            ))
            .with_argument(ShellArgumentSpec::opaque("destination")),
        ShellCommandSpec::new("scp", "Copy files over SSH").with_argument(path.clone()),
        ShellCommandSpec::new("ps", "Display process status")
            .with_option(flag(["-a"], "Include other users' processes"))
            .with_option(flag(["-x"], "Include processes without terminals")),
        ShellCommandSpec::new("kill", "Send a signal to a process")
            .with_argument(ShellArgumentSpec::integer("pid").repeated()),
        ShellCommandSpec::new("env", "Run a command in a modified environment"),
        ShellCommandSpec::new("sudo", "Run a command as another user").with_option(value(
            ["-u", "--user"],
            ShellArgumentSpec::opaque("user"),
            "Target user",
        )),
        ShellCommandSpec::new("nohup", "Run a command immune to hangups"),
        ShellCommandSpec::new("time", "Measure command execution time"),
        ShellCommandSpec::new("xargs", "Build command lines from standard input"),
        ShellCommandSpec::new("make", "Build targets from a Makefile").with_option(value(
            ["-j", "--jobs"],
            ShellArgumentSpec::integer("jobs"),
            "Parallel jobs",
        )),
        ShellCommandSpec::new("just", "Run recipes from a justfile"),
        ShellCommandSpec::new("pytest", "Run Python tests")
            .with_option(flag(["-q", "--quiet"], "Reduce output"))
            .with_option(value(
                ["-k"],
                ShellArgumentSpec::opaque("expression"),
                "Select tests",
            ))
            .with_argument(path),
    ]
    .into_iter()
    .map(ShellCommandSpec::requiring_executable)
    .collect()
}
