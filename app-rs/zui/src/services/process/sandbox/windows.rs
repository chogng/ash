use std::ffi::OsStr;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::path::PathBuf;

use sha2::Digest;
use sha2::Sha256;

use super::PreparedProcessCommand;
use super::ProcessCommand;
use super::ProcessFileSystemAccess;
use super::ProcessNetworkAccess;
use super::ProcessSandboxError;
use super::ProcessSandboxKind;
use super::ProcessSandboxPolicy;

mod acl;
mod native;

const ACCESS_FLAG: &str = "--access";
const WORKING_DIRECTORY_FLAG: &str = "--working-directory";
const COMMAND_SEPARATOR: &str = "--";
const READ_ONLY_ACCESS: &str = "read-only";
const WORKING_DIRECTORY_WRITE_ACCESS: &str = "working-directory-write";
const ENFORCEMENT_FAILURE_EXIT_CODE: i32 = 125;

pub(super) fn default_runner_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
        .unwrap_or_default()
        .join("zui-appcontainer-runner.exe")
}

pub(super) fn prepare(
    runner: &Path,
    command: &ProcessCommand,
    policy: ProcessSandboxPolicy,
    working_directory: PathBuf,
) -> Result<PreparedProcessCommand, ProcessSandboxError> {
    if policy.network() != ProcessNetworkAccess::Denied {
        return Err(ProcessSandboxError::message(
            "Windows AppContainer currently accepts restricted commands only when network access is denied",
        ));
    }
    let access = match policy.file_system() {
        ProcessFileSystemAccess::ReadOnly => READ_ONLY_ACCESS,
        ProcessFileSystemAccess::WorkingDirectoryWrite => WORKING_DIRECTORY_WRITE_ACCESS,
        ProcessFileSystemAccess::FullAccess => {
            return Err(ProcessSandboxError::message(
                "Windows AppContainer cannot combine full host filesystem access with network isolation",
            ));
        }
    };
    let runner = runner.canonicalize().map_err(|source| {
        ProcessSandboxError::message(format!(
            "packaged AppContainer runner {} is unavailable: {source}",
            runner.display()
        ))
    })?;
    if !runner.is_file() {
        return Err(ProcessSandboxError::message(
            "packaged AppContainer runner is not a regular file",
        ));
    }
    let mut arguments = vec![
        ACCESS_FLAG.into(),
        access.into(),
        WORKING_DIRECTORY_FLAG.into(),
        working_directory.as_os_str().to_owned(),
        COMMAND_SEPARATOR.into(),
        command.program().as_os_str().to_owned(),
    ];
    arguments.extend(command.arguments().iter().cloned());
    Ok(PreparedProcessCommand::new(
        ProcessSandboxKind::WindowsAppContainer,
        runner,
        arguments,
        Some(working_directory),
    ))
}

pub(super) fn runner_main() -> ! {
    match run(std::env::args_os().skip(1).collect()) {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("zui AppContainer enforcement failed: {message}");
            std::process::exit(ENFORCEMENT_FAILURE_EXIT_CODE)
        }
    }
}

fn run(arguments: Vec<OsString>) -> Result<i32, String> {
    let request = RunnerRequest::parse(arguments)?;
    let working_directory =
        native::canonical_directory(&request.working_directory, "sandbox working directory")?;
    let program = native::canonical_file(
        &resolve_program(&working_directory, &request.command[0]),
        "sandboxed program",
    )?;
    let access = request
        .access
        .to_str()
        .ok_or("filesystem access mode is not valid Unicode")?;
    let permissions = match access {
        READ_ONLY_ACCESS => acl::DirectoryAccess::ReadOnly,
        WORKING_DIRECTORY_WRITE_ACCESS => acl::DirectoryAccess::ReadWrite,
        _ => return Err("unsupported filesystem access mode".to_owned()),
    };
    let profile = profile_name(&working_directory, access);
    let sid = native::AppContainerSid::ensure(OsStr::new(&profile))?;
    acl::grant_directory_tree(&working_directory, sid.as_ptr(), permissions)?;
    acl::grant_file_read_execute(&program, sid.as_ptr())?;

    let mut command = request.command;
    command[0] = program.into_os_string();
    native::launch(&sid, &command, &working_directory)
}

fn resolve_program(working_directory: &Path, program: &OsStr) -> PathBuf {
    let program = PathBuf::from(program);
    if program.is_relative() {
        working_directory.join(program)
    } else {
        program
    }
}

fn profile_name(working_directory: &Path, access: &str) -> String {
    let mut digest = Sha256::new();
    for word in working_directory.as_os_str().encode_wide() {
        digest.update(word.to_le_bytes());
    }
    digest.update([0]);
    digest.update(access.as_bytes());
    let digest = digest.finalize();
    let suffix = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mode = if access == READ_ONLY_ACCESS {
        "ro"
    } else {
        "rw"
    };
    format!("Zui.Process.v1.{mode}.{suffix}")
}

struct RunnerRequest {
    access: OsString,
    working_directory: PathBuf,
    command: Vec<OsString>,
}

impl RunnerRequest {
    fn parse(arguments: Vec<OsString>) -> Result<Self, String> {
        let mut access = None;
        let mut working_directory = None;
        let mut command = None;
        let mut arguments = arguments.into_iter();
        while let Some(flag) = arguments.next() {
            if flag == COMMAND_SEPARATOR {
                command = Some(arguments.collect::<Vec<_>>());
                break;
            }
            let value = arguments
                .next()
                .ok_or_else(|| format!("missing value for {}", flag.to_string_lossy()))?;
            match flag.to_str() {
                Some(ACCESS_FLAG) => access = Some(value),
                Some(WORKING_DIRECTORY_FLAG) => {
                    working_directory = Some(PathBuf::from(value));
                }
                _ => return Err(format!("unexpected argument {}", flag.to_string_lossy())),
            }
        }
        let command = command.ok_or("missing command separator")?;
        if command.is_empty() {
            return Err("missing sandboxed command".to_owned());
        }
        Ok(Self {
            access: access.ok_or("missing filesystem access mode")?,
            working_directory: working_directory.ok_or("missing working directory")?,
            command,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::COMMAND_SEPARATOR;
    use super::READ_ONLY_ACCESS;
    use super::RunnerRequest;
    use super::WORKING_DIRECTORY_FLAG;
    use super::profile_name;

    #[test]
    fn runner_request_preserves_literal_command_boundaries() {
        let request = RunnerRequest::parse(vec![
            "--access".into(),
            READ_ONLY_ACCESS.into(),
            WORKING_DIRECTORY_FLAG.into(),
            "C:\\dir".into(),
            COMMAND_SEPARATOR.into(),
            "tool.exe".into(),
            "argument with spaces".into(),
        ])
        .unwrap();
        assert_eq!(request.access, OsString::from(READ_ONLY_ACCESS));
        assert_eq!(request.working_directory, std::path::Path::new("C:\\dir"));
        assert_eq!(
            request.command,
            [
                OsString::from("tool.exe"),
                OsString::from("argument with spaces")
            ]
        );
    }

    #[test]
    fn runner_request_rejects_missing_or_unknown_authority() {
        assert!(RunnerRequest::parse(vec![COMMAND_SEPARATOR.into()]).is_err());
        assert!(
            RunnerRequest::parse(vec![
                "--unknown".into(),
                "value".into(),
                COMMAND_SEPARATOR.into(),
                "tool.exe".into()
            ])
            .is_err()
        );
    }

    #[test]
    fn appcontainer_profile_identity_is_stable_and_authority_specific() {
        let directory = std::path::Path::new("C:\\dir");
        let read_only = profile_name(directory, READ_ONLY_ACCESS);
        assert_eq!(read_only, profile_name(directory, READ_ONLY_ACCESS));
        assert_ne!(
            read_only,
            profile_name(directory, super::WORKING_DIRECTORY_WRITE_ACCESS)
        );
        assert!(read_only.starts_with("Zui.Process.v1.ro."));
    }
}
