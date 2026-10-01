use super::*;
use tokio::net::windows::named_pipe::ClientOptions;
use windows_sys::Win32::Foundation::ERROR_NO_TOKEN;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE;
use windows_sys::Win32::Security::DuplicateTokenEx;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::TOKEN_DUPLICATE;
use windows_sys::Win32::Security::TOKEN_IMPERSONATE;
use windows_sys::Win32::Security::TOKEN_USER;
use windows_sys::Win32::Security::TokenImpersonation;
use windows_sys::Win32::Security::TokenUser;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::OpenProcessToken;
use windows_sys::Win32::System::Threading::SetThreadToken;

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn process_token() -> Handle {
    let mut raw = std::ptr::null_mut();
    assert_ne!(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) },
        0
    );
    Handle(raw)
}

fn owner() -> String {
    let token = process_token();
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size);
    }
    let mut bytes = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    assert_ne!(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                bytes.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        },
        0
    );
    let user = unsafe { &*bytes.as_ptr().cast::<TOKEN_USER>() };
    let mut raw = std::ptr::null_mut();
    assert_ne!(
        unsafe { ConvertSidToStringSidW(user.User.Sid, &mut raw) },
        0
    );
    let _allocation = Local(raw.cast());
    let mut length = 0;
    while unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(raw, length) }).unwrap()
}

fn pipe_name() -> String {
    use std::sync::atomic::AtomicU64;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    format!(
        r"\\.\pipe\AshSandboxTest-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[tokio::test]
async fn real_pipe_plan_uses_the_caller_and_preserves_thread_identity() {
    let name = pipe_name();
    let mut pipe = listener(&name).unwrap();
    let runner = std::env::current_exe().unwrap();
    let client = tokio::spawn(async move {
        let mut client = ClientOptions::new()
            .security_qos_flags(windows_sys::Win32::Storage::FileSystem::SECURITY_IMPERSONATION)
            .open(name)
            .unwrap();
        let message = Message {
            version: PROTOCOL_VERSION,
            request: Request::SetupPlan { runner, slots: 1 },
        };
        let bytes = serde_json::to_vec(&message).unwrap();
        client.write_u32_le(bytes.len() as u32).await.unwrap();
        client.write_all(&bytes).await.unwrap();
        let length = client.read_u32_le().await.unwrap() as usize;
        let mut bytes = vec![0; length];
        client.read_exact(&mut bytes).await.unwrap();
        serde_json::from_slice::<Response>(&bytes).unwrap()
    });
    pipe.connect().await.unwrap();
    let message = read_request(&mut pipe).await.unwrap();
    let raw = pipe.as_raw_handle() as usize;
    let response = tokio::task::spawn_blocking(move || {
        let response = authenticated_dispatch(raw as HANDLE, message);
        let mut token = std::ptr::null_mut();
        assert_eq!(
            unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) },
            0
        );
        assert_eq!(unsafe { GetLastError() }, ERROR_NO_TOKEN);
        response
    })
    .await
    .unwrap();
    write_response(&mut pipe, &response).await.unwrap();
    let Response::Completed { data } = client.await.unwrap() else {
        panic!("authenticated plan was rejected: {response:?}");
    };
    assert_eq!(data["changes"]["accounts"]["total"], 3);
    assert_eq!(data["changes"]["ownerSid"], owner());
    assert_eq!(data["sha256"].as_str().unwrap().len(), 64);
    pipe.disconnect().unwrap();
}

#[tokio::test]
async fn identification_only_client_cannot_dispatch_a_request() {
    let name = pipe_name();
    let mut pipe = listener(&name).unwrap();
    let client = tokio::spawn(async move {
        let mut client = ClientOptions::new().open(name).unwrap();
        let bytes = serde_json::to_vec(&Message {
            version: PROTOCOL_VERSION,
            request: Request::Status {},
        })
        .unwrap();
        client.write_u32_le(bytes.len() as u32).await.unwrap();
        client.write_all(&bytes).await.unwrap();
        client
    });
    pipe.connect().await.unwrap();
    let message = read_request(&mut pipe).await.unwrap();
    let raw = pipe.as_raw_handle() as usize;
    let response =
        tokio::task::spawn_blocking(move || authenticated_dispatch(raw as HANDLE, message))
            .await
            .unwrap();
    assert!(
        matches!(response, Response::Rejected { error } if error.contains("impersonation token"))
    );
    drop(client.await.unwrap());
}

#[tokio::test]
async fn restricted_client_is_rejected_before_provisioning() {
    let name = pipe_name();
    let mut pipe = listener(&name).unwrap();
    let client = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::SECURITY_IMPERSONATION;
        use windows_sys::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT;
        let token = process_token();
        let mut sid = std::ptr::null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(wide("S-1-5-32-545").as_ptr(), &mut sid) },
            0
        );
        let _sid = Local(sid);
        let restriction = SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: 0,
        };
        let mut raw = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                CreateRestrictedToken(
                    token.0,
                    DISABLE_MAX_PRIVILEGE,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    1,
                    &restriction,
                    &mut raw,
                )
            },
            0
        );
        let restricted = Handle(raw);
        let mut raw = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateTokenEx(
                    restricted.0,
                    TOKEN_QUERY | TOKEN_IMPERSONATE,
                    std::ptr::null(),
                    SecurityImpersonation,
                    TokenImpersonation,
                    &mut raw,
                )
            },
            0
        );
        let impersonation = Handle(raw);
        assert_ne!(
            unsafe { SetThreadToken(std::ptr::null(), impersonation.0) },
            0
        );
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                assert_ne!(unsafe { RevertToSelf() }, 0);
            }
        }
        let _restore = Restore;
        let mut client = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION)
            .open(name)
            .unwrap();
        let bytes = serde_json::to_vec(&Message {
            version: PROTOCOL_VERSION,
            request: Request::Setup {
                runner: std::env::current_exe().unwrap(),
                slots: 1,
                approved: "untrusted".into(),
            },
        })
        .unwrap();
        client
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .unwrap();
        client.write_all(&bytes).unwrap();
        client
    });
    pipe.connect().await.unwrap();
    let message = read_request(&mut pipe).await.unwrap();
    let raw = pipe.as_raw_handle() as usize;
    let response =
        tokio::task::spawn_blocking(move || authenticated_dispatch(raw as HANDLE, message))
            .await
            .unwrap();
    assert!(
        matches!(response, Response::Rejected { error } if error.contains("restricted tokens"))
    );
    drop(client.await.unwrap());
}

#[tokio::test]
async fn oversized_request_is_rejected_before_dispatch() {
    let name = pipe_name();
    let mut pipe = listener(&name).unwrap();
    let client = tokio::spawn(async move {
        let mut client = ClientOptions::new().open(name).unwrap();
        client
            .write_u32_le(MAX_MESSAGE_BYTES as u32 + 1)
            .await
            .unwrap();
    });
    pipe.connect().await.unwrap();
    assert!(
        read_request(&mut pipe)
            .await
            .unwrap_err()
            .contains("request size")
    );
    client.await.unwrap();
}
