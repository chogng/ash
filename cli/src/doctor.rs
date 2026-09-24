use ash_install_context::InstallContext;
use serde::Serialize;
use serde_json::Value;

use crate::CliError;
use crate::management;
use crate::print_json;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    build: build_info::BuildInfo,
    checks: Vec<Check>,
}

#[derive(Serialize)]
struct Check {
    name: &'static str,
    status: Status,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Passed,
    Warning,
    Failed,
}

impl Report {
    fn record(&mut self, name: &'static str, result: Result<String, CliError>) {
        let (status, detail) = match result {
            Ok(detail) => (Status::Passed, detail),
            Err(error) => (Status::Failed, error.message),
        };
        self.checks.push(Check {
            name,
            status,
            detail,
            data: None,
        });
    }

    fn failed(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.status == Status::Failed)
    }
}

#[derive(clap::Args)]
pub(super) struct Options {
    /// Print the complete diagnostic report as JSON.
    #[arg(long)]
    json: bool,
}

pub(super) fn run(options: Options) -> Result<(), CliError> {
    let mut report = Report {
        build: build_info::BuildInfo::current(),
        checks: Vec::new(),
    };
    let installation = InstallContext::current();
    report.record(
        "installation",
        std::env::current_exe()
            .map(|path| format!("{} ({:?})", path.display(), installation.method()))
            .map_err(CliError::failure),
    );
    report.record(
        "profile",
        crate::profile_root().map(|path| path.display().to_string()),
    );
    report.record(
        "app-server executable",
        ash_app_server_daemon::backend_executable_path()
            .map_err(CliError::failure)
            .and_then(|path| {
                if path.is_file() {
                    Ok(path.display().to_string())
                } else {
                    Err(CliError::failure(format!("not found: {}", path.display())))
                }
            }),
    );
    match management::connect() {
        Ok(session) => {
            report.record(
                "app-server connection",
                Ok("protocol handshake succeeded".into()),
            );
            let mut client = session.client();
            report.record(
                "configuration",
                client
                    .read_config()
                    .map(|config| {
                        format!(
                            "revision {}; {} providers; {} MCP servers",
                            config.revision,
                            config.providers.len(),
                            config.mcp_servers.len()
                        )
                    })
                    .map_err(CliError::failure),
            );
            match client.read_accounts() {
                Ok(accounts) if accounts.accounts.is_empty() => report.checks.push(Check {
                    name: "accounts",
                    status: Status::Warning,
                    detail: "no subscription account; API-key providers can still be used".into(),
                    data: None,
                }),
                result => report.record(
                    "accounts",
                    result
                        .map(|accounts| {
                            format!("{} subscription accounts", accounts.accounts.len())
                        })
                        .map_err(CliError::failure),
                ),
            }
            match client.read_diagnostics() {
                Ok(snapshot) => report.checks.push(Check {
                    name: "runtime diagnostics",
                    status: Status::Passed,
                    detail: format!("{} recent observations", snapshot.recent.len()),
                    data: Some(serde_json::to_value(snapshot).map_err(CliError::failure)?),
                }),
                Err(error) => report.record("runtime diagnostics", Err(error.into())),
            }
            report.record(
                "connection shutdown",
                session
                    .shutdown()
                    .map(|()| "closed".into())
                    .map_err(CliError::failure),
            );
        }
        Err(error) => report.record("app-server connection", Err(error)),
    }
    if options.json {
        print_json(&report)?;
    } else {
        println!("Ash {} ({})", report.build.version, report.build.target);
        for check in &report.checks {
            let status = match check.status {
                Status::Passed => "OK",
                Status::Warning => "WARN",
                Status::Failed => "FAIL",
            };
            println!("[{status}] {}: {}", check.name, check.detail);
        }
    }
    if report.failed() {
        Err(CliError::failure("diagnostic checks failed"))
    } else {
        Ok(())
    }
}
