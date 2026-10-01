//! Administrator-owned service image, SCM registration, and approved lifecycle changes.

use crate::service::descriptor;
use crate::service::error;
use crate::service::wide;
use sha2::Digest;
use std::fs::File;
use std::fs::OpenOptions;
use std::os::windows::fs::MetadataExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use windows_sandbox::provisioning::SERVICE_NAME;
use windows_sandbox::provisioning::service_directory;
use windows_sys::Win32::Foundation::ERROR_SERVICE_DOES_NOT_EXIST;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
use windows_sys::Win32::Storage::FileSystem::DELETE;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
use windows_sys::Win32::System::Services::CloseServiceHandle;
use windows_sys::Win32::System::Services::ControlService;
use windows_sys::Win32::System::Services::CreateServiceW;
use windows_sys::Win32::System::Services::DeleteService;
use windows_sys::Win32::System::Services::OpenSCManagerW;
use windows_sys::Win32::System::Services::OpenServiceW;
use windows_sys::Win32::System::Services::QUERY_SERVICE_CONFIGW;
use windows_sys::Win32::System::Services::QueryServiceConfigW;
use windows_sys::Win32::System::Services::QueryServiceStatus;
use windows_sys::Win32::System::Services::SC_HANDLE;
use windows_sys::Win32::System::Services::SC_MANAGER_CONNECT;
use windows_sys::Win32::System::Services::SC_MANAGER_CREATE_SERVICE;
use windows_sys::Win32::System::Services::SERVICE_AUTO_START;
use windows_sys::Win32::System::Services::SERVICE_CONTROL_STOP;
use windows_sys::Win32::System::Services::SERVICE_ERROR_NORMAL;
use windows_sys::Win32::System::Services::SERVICE_QUERY_CONFIG;
use windows_sys::Win32::System::Services::SERVICE_QUERY_STATUS;
use windows_sys::Win32::System::Services::SERVICE_RUNNING;
use windows_sys::Win32::System::Services::SERVICE_START;
use windows_sys::Win32::System::Services::SERVICE_STATUS;
use windows_sys::Win32::System::Services::SERVICE_STOP;
use windows_sys::Win32::System::Services::SERVICE_STOP_PENDING;
use windows_sys::Win32::System::Services::SERVICE_STOPPED;
use windows_sys::Win32::System::Services::SERVICE_WIN32_OWN_PROCESS;
use windows_sys::Win32::System::Services::StartServiceW;

struct ServiceHandle(SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}

fn manager() -> Result<ServiceHandle, String> {
    let handle = unsafe {
        OpenSCManagerW(
            std::ptr::null(),
            std::ptr::null(),
            SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE,
        )
    };
    if handle.is_null() {
        return Err(error("OpenSCManagerW(installer)"));
    }
    Ok(ServiceHandle(handle))
}

fn open(manager: &ServiceHandle) -> Result<Option<ServiceHandle>, String> {
    let handle = unsafe {
        OpenServiceW(
            manager.0,
            wide(SERVICE_NAME).as_ptr(),
            SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP | DELETE,
        )
    };
    if handle.is_null() {
        if unsafe { GetLastError() } == ERROR_SERVICE_DOES_NOT_EXIST {
            return Ok(None);
        }
        return Err(error("OpenServiceW(installer)"));
    }
    let service = ServiceHandle(handle);
    let mut size = 0;
    unsafe {
        QueryServiceConfigW(service.0, std::ptr::null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(error("QueryServiceConfigW(size)"));
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe { QueryServiceConfigW(service.0, buffer.as_mut_ptr().cast(), size, &mut size) } == 0 {
        return Err(error("QueryServiceConfigW"));
    }
    let config = unsafe { &*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>() };
    let mut length = 0;
    while unsafe { *config.lpBinaryPathName.add(length) } != 0 {
        length += 1;
    }
    let command =
        String::from_utf16(unsafe { std::slice::from_raw_parts(config.lpBinaryPathName, length) })
            .map_err(|error| error.to_string())?;
    let expected = format!("\"{}\"", image()?.display());
    let mut length = 0;
    while unsafe { *config.lpServiceStartName.add(length) } != 0 {
        length += 1;
    }
    let account = String::from_utf16(unsafe {
        std::slice::from_raw_parts(config.lpServiceStartName, length)
    })
    .map_err(|error| error.to_string())?;
    if command != expected
        || config.dwServiceType != SERVICE_WIN32_OWN_PROCESS
        || config.dwStartType != SERVICE_AUTO_START
        || account != "LocalSystem"
    {
        return Err("registered service does not match the Ash installation".into());
    }
    Ok(Some(service))
}

fn image() -> Result<PathBuf, String> {
    Ok(service_directory()?.join("bin/ash-windows-sandbox-service.exe"))
}

fn hash(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", sha2::Sha256::digest(bytes)))
}

fn digest(plan: &serde_json::Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        sha2::Sha256::digest(serde_json::to_vec(plan).map_err(|error| error.to_string())?)
    ))
}

fn plan(operation: &str) -> Result<serde_json::Value, String> {
    let root = service_directory()?;
    let installed = if image()?.try_exists().map_err(|error| error.to_string())? {
        Some(hash(&image()?)?)
    } else {
        None
    };
    let runtimes = if root
        .join("runtimes")
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        let mut names = std::fs::read_dir(root.join("runtimes"))
            .map_err(|error| error.to_string())?
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        names.sort();
        names
    } else {
        Vec::new()
    };
    let mut result = serde_json::json!({
        "operation": operation, "serviceName": SERVICE_NAME, "serviceDirectory": root,
        "installedServiceSha256": installed, "runtimes": runtimes,
        "account": "LocalSystem", "start": "automatic",
        "access": "administrators own binaries; management impersonates the pipe caller"
    });
    if operation == "install" {
        result["serviceSha256"] =
            hash(&std::env::current_exe().map_err(|error| error.to_string())?)?.into();
    }
    Ok(result)
}

fn approved(operation: &str, approval: &str) -> Result<(), String> {
    if digest(&plan(operation)?)? != approval {
        return Err(
            "service approval does not match the current image, location, and runtimes".into(),
        );
    }
    Ok(())
}

fn create_directory(path: &Path) -> Result<(), String> {
    let sd = descriptor("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)")?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
        return Err(error("CreateDirectoryW(service)"));
    }
    Ok(())
}

/// Reject redirected objects before any copy or delete. Held directory and image
/// handles prevent replacement while checking the administrator-approved digest.
fn pins(path: &Path) -> Result<Vec<File>, String> {
    let mut result = Vec::new();
    let mut chain = path.ancestors().collect::<Vec<_>>();
    chain.reverse();
    for part in chain {
        if !part.try_exists().map_err(|error| error.to_string())? {
            break;
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(if part == path {
                FILE_SHARE_READ
            } else {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            })
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(part)
            .map_err(|error| error.to_string())?;
        if file
            .metadata()
            .map_err(|error| error.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("service installation path contains a reparse point".into());
        }
        result.push(file);
    }
    Ok(result)
}

fn validate_layout(root: &Path) -> Result<(), String> {
    for (directory, allowed) in [
        (root.to_path_buf(), &["bin", "runtimes", "install.lock"][..]),
        (
            root.join("bin"),
            &["ash-windows-sandbox-service.exe", "service.pending"][..],
        ),
    ] {
        if !directory.exists() {
            continue;
        }
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || !allowed.contains(&entry.file_name().to_string_lossy().as_ref())
            {
                return Err(
                    "service installation contains an unrecorded or redirected object".into(),
                );
            }
        }
    }
    Ok(())
}

fn status(service: &ServiceHandle) -> Result<SERVICE_STATUS, String> {
    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { QueryServiceStatus(service.0, &mut status) } == 0 {
        return Err(error("QueryServiceStatus"));
    }
    Ok(status)
}

fn wait(service: &ServiceHandle, desired: u32) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let current = status(service)?;
        if current.dwCurrentState == desired {
            return Ok(());
        }
        if desired == SERVICE_RUNNING && current.dwCurrentState == SERVICE_STOPPED {
            return Err(format!(
                "sandbox service startup failed (Windows {}, service {})",
                current.dwWin32ExitCode, current.dwServiceSpecificExitCode
            ));
        }
        if Instant::now() >= deadline {
            return Err("sandbox service did not complete its state change".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn stop(service: &ServiceHandle) -> Result<(), String> {
    match status(service)?.dwCurrentState {
        SERVICE_STOPPED => return Ok(()),
        SERVICE_STOP_PENDING => return wait(service, SERVICE_STOPPED),
        _ => {}
    }
    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) } == 0 {
        return Err(error("ControlService(stop)"));
    }
    wait(service, SERVICE_STOPPED)
}

fn install(approval: &str) -> Result<(), String> {
    let source = std::fs::canonicalize(std::env::current_exe().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let _source = pins(&source)?;
    approved("install", approval)?;
    if image()?.exists()
        && source == std::fs::canonicalize(image()?).map_err(|error| error.to_string())?
    {
        return Err(
            "run the service installer from the product package, outside its installed directory"
                .into(),
        );
    }
    let manager = manager()?;
    let existing = open(&manager)?;
    let root = service_directory()?;
    let _parent = pins(root.parent().ok_or("service directory has no parent")?)?;
    if !root.try_exists().map_err(|error| error.to_string())? {
        create_directory(&root)?;
    }
    let root_pins = pins(&root)?;
    validate_layout(&root)?;
    // Do not adopt a directory planted by an unelevated user. Stamp only a newly
    // created object; existing ownership is verified before it can host SYSTEM.
    windows_sandbox::provisioning::validate_service_path(&root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join("install.lock"))
        .map_err(|error| error.to_string())?;
    approved("install", approval)?;
    for name in ["bin", "runtimes"] {
        let path = root.join(name);
        if !path.exists() {
            create_directory(&path)?;
        }
        windows_sandbox::provisioning::validate_service_path(&path)?;
    }
    if let Some(service) = &existing {
        stop(service)?;
    }
    let pending = root.join("bin/service.pending");
    windows_sandbox::provisioning::copy_service_image(&source, &pending, &["S-1-5-32-545".into()])?;
    if unsafe {
        MoveFileExW(
            wide(&pending).as_ptr(),
            wide(image()?).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(error("MoveFileExW(service image)"));
    }
    let service = match existing {
        Some(service) => service,
        None => {
            let command = format!("\"{}\"", image()?.display());
            let raw = unsafe {
                CreateServiceW(
                    manager.0,
                    wide(SERVICE_NAME).as_ptr(),
                    wide(SERVICE_NAME).as_ptr(),
                    SERVICE_START | SERVICE_QUERY_STATUS,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_AUTO_START,
                    SERVICE_ERROR_NORMAL,
                    wide(command).as_ptr(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if raw.is_null() {
                return Err(error("CreateServiceW"));
            }
            ServiceHandle(raw)
        }
    };
    if unsafe { StartServiceW(service.0, 0, std::ptr::null()) } == 0 {
        return Err(error("StartServiceW"));
    }
    wait(&service, SERVICE_RUNNING)?;
    drop(lock);
    drop(root_pins);
    Ok(())
}

fn uninstall(approval: &str) -> Result<(), String> {
    approved("uninstall", approval)?;
    if image()?.exists()
        && std::fs::canonicalize(std::env::current_exe().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?
            == std::fs::canonicalize(image()?).map_err(|error| error.to_string())?
    {
        return Err(
            "run service removal from the product package, outside its installed directory".into(),
        );
    }
    let root = service_directory()?;
    let root_pins = pins(&root)?;
    validate_layout(&root)?;
    windows_sandbox::provisioning::validate_service_path(&root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .create(true)
        .truncate(false)
        .open(root.join("install.lock"))
        .map_err(|error| error.to_string())?;
    let manager = manager()?;
    let service = open(&manager)?;
    approved("uninstall", approval)?;
    if root.join("runtimes").exists()
        && std::fs::read_dir(root.join("runtimes"))
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
    {
        return Err("remove every recorded user runtime before uninstalling the service".into());
    }
    if let Some(service) = &service {
        stop(service)?;
    }
    if let Some(service) = service {
        if unsafe { DeleteService(service.0) } == 0 {
            return Err(error("DeleteService"));
        }
    }
    for path in [image()?, root.join("bin/service.pending")] {
        if path.try_exists().map_err(|error| error.to_string())? {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    for name in ["bin", "runtimes"] {
        if root.join(name).exists() {
            std::fs::remove_dir(root.join(name)).map_err(|error| error.to_string())?;
        }
    }
    drop(lock);
    std::fs::remove_file(root.join("install.lock")).map_err(|error| error.to_string())?;
    drop(root_pins);
    std::fs::remove_dir(root).map_err(|error| error.to_string())
}

pub(crate) fn run(arguments: &[String]) -> Result<(), String> {
    match arguments {
        [command, operation] if command == "plan" && matches!(operation.as_str(), "install" | "uninstall") => {
            let changes = plan(operation)?;
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({"sha256": digest(&changes)?, "changes": changes})).map_err(|error| error.to_string())?);
            Ok(())
        }
        [command, flag, approval] if flag == "--approve" && command == "install" => install(approval),
        [command, flag, approval] if flag == "--approve" && command == "uninstall" => uninstall(approval),
        _ => Err("usage: ash-windows-sandbox-service plan install | install --approve SHA256 | plan uninstall | uninstall --approve SHA256".into()),
    }
}

#[cfg(test)]
#[path = "installation_tests.rs"]
mod tests;
