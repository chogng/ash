// Licensed under the MIT License.
//! Dedicated local identities and user-bound encrypted runtime state.

use super::win;
use super::win::Result;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use windows_sys::Win32::NetworkManagement::NetManagement::NetApiBufferFree;
use windows_sys::Win32::NetworkManagement::NetManagement::NetUserAdd;
use windows_sys::Win32::NetworkManagement::NetManagement::NetUserDel;
use windows_sys::Win32::NetworkManagement::NetManagement::NetUserGetInfo;
use windows_sys::Win32::NetworkManagement::NetManagement::UF_DONT_EXPIRE_PASSWD;
use windows_sys::Win32::NetworkManagement::NetManagement::UF_NORMAL_ACCOUNT;
use windows_sys::Win32::NetworkManagement::NetManagement::UF_SCRIPT;
use windows_sys::Win32::NetworkManagement::NetManagement::USER_INFO_1;
use windows_sys::Win32::NetworkManagement::NetManagement::USER_PRIV_USER;
use windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB;
use windows_sys::Win32::Security::Cryptography::CRYPTPROTECT_UI_FORBIDDEN;
use windows_sys::Win32::Security::Cryptography::CryptProtectData;
use windows_sys::Win32::Security::Cryptography::CryptUnprotectData;
use windows_sys::Win32::Security::LookupAccountNameW;
use windows_sys::Win32::Security::SID_NAME_USE;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum NetworkMode {
    Denied,
    Managed,
    Allowed,
}

/// Passwords only exist in the protected state and the account logon call.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Account {
    pub(super) name: String,
    pub(super) sid: String,
    pub(super) password: String,
    pub(super) mode: NetworkMode,
    pub(super) proxy_port: u16,
    pub(super) tag: String,
}

impl Drop for Account {
    fn drop(&mut self) {
        // Keep plaintext account credentials out of freed reusable buffers.
        for byte in unsafe { self.password.as_bytes_mut() } {
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}

pub(super) fn plan(mode: NetworkMode, proxy_port: u16) -> Result<Account> {
    let name = format!("ash{}", win::random_hex(8)?);
    let password = format!("Aa1!{}", win::random_hex(24)?);
    Ok(Account {
        name,
        sid: String::new(),
        password,
        mode,
        proxy_port,
        tag: format!("Ash:{}", win::random_hex(16)?),
    })
}

fn owned_account(account: &Account) -> Result<Option<String>> {
    let mut buffer = std::ptr::null_mut();
    let status = unsafe {
        NetUserGetInfo(
            std::ptr::null(),
            win::wide(&account.name).as_ptr(),
            1,
            &mut buffer,
        )
    };
    if status == 2221 {
        return Ok(None);
    }
    if status != 0 {
        return Err(format!("NetUserGetInfo failed (Windows error {status})"));
    }
    let info = unsafe { &*buffer.cast::<USER_INFO_1>() };
    let comment = if info.usri1_comment.is_null() {
        String::new()
    } else {
        let mut length = 0;
        unsafe {
            while *info.usri1_comment.add(length) != 0 {
                length += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(info.usri1_comment, length))
        }
    };
    unsafe {
        NetApiBufferFree(buffer.cast());
    }
    let sid = lookup(&account.name)?;
    if comment != account.tag || (!account.sid.is_empty() && sid != account.sid) {
        return Err("a runtime account does not match its recorded ownership".into());
    }
    Ok(Some(sid))
}

pub(super) fn create(account: &mut Account) -> Result<()> {
    if let Some(sid) = owned_account(account)? {
        account.sid = sid;
        return ensure_users_membership(account);
    }
    let name_w = win::wide(&account.name);
    let mut password_w = win::wide(&account.password);
    let comment = win::wide(&account.tag);
    let info = USER_INFO_1 {
        usri1_name: name_w.as_ptr().cast_mut(),
        usri1_password: password_w.as_mut_ptr(),
        usri1_priv: USER_PRIV_USER,
        usri1_comment: comment.as_ptr().cast_mut(),
        usri1_flags: UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD,
        ..unsafe { std::mem::zeroed() }
    };
    let status = unsafe {
        NetUserAdd(
            std::ptr::null(),
            1,
            (&info as *const USER_INFO_1).cast(),
            std::ptr::null_mut(),
        )
    };
    for value in &mut password_w {
        unsafe {
            std::ptr::write_volatile(value, 0);
        }
    }
    if status != 0 {
        return Err(format!("NetUserAdd failed (Windows error {status})"));
    }
    match lookup(&account.name) {
        Ok(sid) => {
            account.sid = sid;
            ensure_users_membership(account)
        }
        Err(error) => {
            unsafe {
                NetUserDel(std::ptr::null(), name_w.as_ptr());
            }
            Err(error)
        }
    }
}

fn ensure_users_membership(account: &Account) -> Result<()> {
    use windows_sys::Win32::NetworkManagement::NetManagement::LOCALGROUP_MEMBERS_INFO_0;
    use windows_sys::Win32::NetworkManagement::NetManagement::NetLocalGroupAddMembers;
    use windows_sys::Win32::Security::LookupAccountSidW;
    let users = win::sid("S-1-5-32-545")?;
    let mut name_size = 0;
    let mut domain_size = 0;
    let mut usage = 0;
    unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            users.0,
            std::ptr::null_mut(),
            &mut name_size,
            std::ptr::null_mut(),
            &mut domain_size,
            &mut usage,
        );
    }
    let mut name = vec![0; name_size as usize];
    let mut domain = vec![0; domain_size as usize];
    if unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            users.0,
            name.as_mut_ptr(),
            &mut name_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut usage,
        )
    } == 0
    {
        return Err(win::error("LookupAccountSidW(Users group)"));
    }
    let sid = win::sid(&account.sid)?;
    let member = LOCALGROUP_MEMBERS_INFO_0 { lgrmi0_sid: sid.0 };
    // Ordinary user membership supplies directory traversal and OS runtime
    // access. It does not grant administrator rights; the child is restricted
    // again with its execution-specific SID before any command runs.
    let status = unsafe {
        NetLocalGroupAddMembers(
            std::ptr::null(),
            name.as_ptr(),
            0,
            (&member as *const LOCALGROUP_MEMBERS_INFO_0).cast(),
            1,
        )
    };
    if status != 0 && status != 1378 {
        return Err(format!(
            "NetLocalGroupAddMembers(Users) failed (Windows error {status})"
        ));
    }
    Ok(())
}

pub(super) fn lookup(name: &str) -> Result<String> {
    let name = win::wide(name);
    let mut sid_size = 0;
    let mut domain_size = 0;
    let mut usage: SID_NAME_USE = 0;
    unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut sid_size,
            std::ptr::null_mut(),
            &mut domain_size,
            &mut usage,
        );
    }
    if sid_size == 0 {
        return Err(win::error("LookupAccountNameW"));
    }
    let mut sid = vec![0u64; (sid_size as usize + 7) / 8];
    let mut domain = vec![0u16; domain_size as usize];
    if unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            name.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut usage,
        )
    } == 0
    {
        return Err(win::error("LookupAccountNameW"));
    }
    win::sid_text(sid.as_mut_ptr().cast())
}

pub(super) fn remove(account: &Account) -> Result<()> {
    if let Some(sid) = owned_account(account)? {
        let mut owned = account.clone();
        owned.sid = sid;
        remove_profile(&owned)?;
        let status = unsafe { NetUserDel(std::ptr::null(), win::wide(&account.name).as_ptr()) };
        if status != 0 {
            return Err(format!("NetUserDel failed (Windows error {status})"));
        }
        if owned_account(account)?.is_some() {
            return Err("the recorded Ash account still exists after removal".into());
        }
    } else if !account.sid.is_empty() {
        // Resume cleanup after a prior run already removed this recorded SID.
        remove_profile(account)?;
    }
    Ok(())
}

fn remove_profile(account: &Account) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::UI::Shell::DeleteProfileW;
    use windows::core::PCWSTR;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::enums::KEY_READ;
    use winreg::enums::KEY_WOW64_64KEY;
    let registry = winreg::RegKey::predef(HKEY_LOCAL_MACHINE);
    let name = format!(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{}",
        account.sid
    );
    let key = match registry.open_subkey_with_flags(&name, KEY_READ | KEY_WOW64_64KEY) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "could not inspect the recorded account profile: {error}"
            ));
        }
    };
    let path = std::path::PathBuf::from(
        key.get_value::<String, _>("ProfileImagePath")
            .map_err(|error| error.to_string())?,
    );
    if !path.is_absolute()
        || !path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(&account.name))
    {
        return Err(
            "recorded account has an unexpected profile path; preserve it for inspection".into(),
        );
    }
    for component in path.ancestors() {
        match std::fs::symlink_metadata(component) {
            Ok(metadata) if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                return Err("refusing to delete a redirected account profile".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    drop(key);
    unsafe {
        DeleteProfileW(
            PCWSTR(win::wide(&account.sid).as_ptr()),
            PCWSTR(win::wide(&path).as_ptr()),
            PCWSTR::null(),
        )
    }
    .map_err(|error| format!("could not delete the recorded account profile: {error}"))?;
    match registry.open_subkey_with_flags(&name, KEY_READ | KEY_WOW64_64KEY) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            return Err("account profile registration still exists or could not be checked".into());
        }
    }
    if path.try_exists().map_err(|error| error.to_string())? {
        return Err("account profile directory still exists after removal".into());
    }
    Ok(())
}

pub(super) fn seal(path: &Path, bytes: &mut [u8]) -> Result<()> {
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "runtime state too large")?,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    if unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    } == 0
    {
        return Err(win::error("CryptProtectData"));
    }
    let _guard = win::Local(output.pbData.cast());
    let encrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    use std::io::Write;
    let pending = path.with_extension("pending");
    let mut file = win::create_service_file(
        &pending,
        &format!(
            "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GR;;;{})",
            win::current_user()?
        ),
    )?;
    file.write_all(encrypted)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            win::wide(&pending).as_ptr(),
            win::wide(path).as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(win::error("MoveFileExW(runtime journal)"))
    } else {
        Ok(())
    }
}

pub(super) fn unseal(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("runtime state exceeds its size limit".into());
    }
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    if unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    } == 0
    {
        return Err(win::error("CryptUnprotectData"));
    }
    let _guard = win::Local(output.pbData.cast());
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    for index in 0..output.cbData as usize {
        unsafe {
            std::ptr::write_volatile(output.pbData.add(index), 0);
        }
    }
    Ok(plaintext)
}
