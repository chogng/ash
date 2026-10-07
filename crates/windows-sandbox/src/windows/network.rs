// Licensed under the MIT License.
//! Account-specific WFP objects have a recorded plan and are installed atomically.

use super::account::Account;
use super::account::NetworkMode;
use super::win;
use super::win::Result;
use serde::Deserialize;
use serde::Serialize;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::GetSecurityDescriptorLength;
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;
use windows_sys::core::GUID;

#[derive(Clone, Copy, Deserialize, Serialize)]
enum Layer {
    ConnectV4,
    ConnectV6,
    ListenV4,
    ListenV6,
    AcceptV4,
    AcceptV6,
}
impl Layer {
    fn key(self) -> GUID {
        match self {
            Self::ConnectV4 => FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            Self::ConnectV6 => FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            Self::ListenV4 => FWPM_LAYER_ALE_AUTH_LISTEN_V4,
            Self::ListenV6 => FWPM_LAYER_ALE_AUTH_LISTEN_V6,
            Self::AcceptV4 => FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            Self::AcceptV6 => FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
        }
    }
}
#[derive(Clone, Copy, Deserialize, Serialize)]
enum Action {
    Block,
    Proxy,
}
impl Action {
    fn value(self) -> u32 {
        match self {
            Self::Block => FWP_ACTION_BLOCK,
            Self::Proxy => FWP_ACTION_PERMIT,
        }
    }
    fn weight(self) -> u8 {
        match self {
            Self::Block => 0,
            Self::Proxy => 10,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct Filter {
    key: [u8; 16],
    account: usize,
    layer: Layer,
    action: Action,
}
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Rules {
    provider: [u8; 16],
    sublayer: [u8; 16],
    filters: Vec<Filter>,
}

fn guid(value: [u8; 16]) -> GUID {
    GUID::from_u128(u128::from_be_bytes(value))
}
fn same_guid(left: &GUID, right: &GUID) -> bool {
    left.data1 == right.data1
        && left.data2 == right.data2
        && left.data3 == right.data3
        && left.data4 == right.data4
}
fn new_key() -> Result<[u8; 16]> {
    let mut value = [0; 16];
    getrandom::getrandom(&mut value).map_err(|error| error.to_string())?;
    Ok(value)
}
fn check(status: u32, operation: &str) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} failed (Windows error {status:#x})"))
    }
}

struct Engine(HANDLE);
impl Engine {
    fn open() -> Result<Self> {
        let mut handle = std::ptr::null_mut();
        check(
            unsafe {
                FwpmEngineOpen0(
                    std::ptr::null(),
                    RPC_C_AUTHN_WINNT,
                    std::ptr::null(),
                    std::ptr::null(),
                    &mut handle,
                )
            },
            "FwpmEngineOpen0",
        )?;
        Ok(Self(handle))
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}

impl Rules {
    pub(super) fn plan(accounts: &[Account]) -> Result<Self> {
        let mut filters = Vec::new();
        for (index, account) in accounts.iter().enumerate() {
            if account.mode == NetworkMode::Allowed {
                continue;
            }
            for layer in [
                Layer::ConnectV4,
                Layer::ConnectV6,
                Layer::ListenV4,
                Layer::ListenV6,
                Layer::AcceptV4,
                Layer::AcceptV6,
            ] {
                filters.push(Filter {
                    key: new_key()?,
                    account: index,
                    layer,
                    action: Action::Block,
                });
            }
            if account.mode == NetworkMode::Managed {
                if account.proxy_port == 0 {
                    return Err("managed account has no proxy port".into());
                }
                filters.push(Filter {
                    key: new_key()?,
                    account: index,
                    layer: Layer::ConnectV4,
                    action: Action::Proxy,
                });
            }
        }
        Ok(Self {
            provider: new_key()?,
            sublayer: new_key()?,
            filters,
        })
    }

    pub(super) fn install(&self, accounts: &[Account]) -> Result<()> {
        let engine = Engine::open()?;
        check(
            unsafe { FwpmTransactionBegin0(engine.0, 0) },
            "FwpmTransactionBegin0",
        )?;
        if let Err(error) = self.add(&engine, accounts) {
            unsafe {
                FwpmTransactionAbort0(engine.0);
            }
            return Err(error);
        }
        check(
            unsafe { FwpmTransactionCommit0(engine.0) },
            "FwpmTransactionCommit0",
        )
    }

    fn add(&self, engine: &Engine, accounts: &[Account]) -> Result<()> {
        let mut name = win::wide("Ash isolated account network policy");
        let provider_key = guid(self.provider);
        let sublayer_key = guid(self.sublayer);
        // Runtime callers may inspect these objects, but cannot edit network policy.
        let access = win::descriptor(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x20080;;;{})",
            win::current_user()?
        ))?;
        let provider = FWPM_PROVIDER0 {
            providerKey: provider_key,
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_mut_ptr(),
                description: std::ptr::null_mut(),
            },
            flags: FWPM_PROVIDER_FLAG_PERSISTENT,
            ..unsafe { std::mem::zeroed() }
        };
        check(
            unsafe { FwpmProviderAdd0(engine.0, &provider, access.0) },
            "FwpmProviderAdd0",
        )?;
        let sublayer = FWPM_SUBLAYER0 {
            subLayerKey: sublayer_key,
            displayData: provider.displayData,
            providerKey: (&provider_key as *const GUID).cast_mut(),
            flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
            weight: 0x8000,
            ..unsafe { std::mem::zeroed() }
        };
        check(
            unsafe { FwpmSubLayerAdd0(engine.0, &sublayer, access.0) },
            "FwpmSubLayerAdd0",
        )?;
        for plan in &self.filters {
            let account = accounts
                .get(plan.account)
                .ok_or("invalid account in network plan")?;
            let user = win::descriptor(&format!("D:(A;;CC;;;{})", account.sid))?;
            let mut blob = FWP_BYTE_BLOB {
                size: unsafe { GetSecurityDescriptorLength(user.0) },
                data: user.0.cast(),
            };
            let conditions = conditions(account, plan.action, &mut blob);
            let filter = FWPM_FILTER0 {
                filterKey: guid(plan.key),
                displayData: provider.displayData,
                flags: FWPM_FILTER_FLAG_PERSISTENT,
                providerKey: (&provider_key as *const GUID).cast_mut(),
                layerKey: plan.layer.key(),
                subLayerKey: sublayer_key,
                weight: FWP_VALUE0 {
                    r#type: FWP_UINT8,
                    Anonymous: FWP_VALUE0_0 {
                        uint8: plan.action.weight(),
                    },
                },
                numFilterConditions: conditions.len() as u32,
                filterCondition: conditions.as_ptr().cast_mut(),
                action: FWPM_ACTION0 {
                    r#type: plan.action.value(),
                    Anonymous: unsafe { std::mem::zeroed() },
                },
                ..unsafe { std::mem::zeroed() }
            };
            check(
                unsafe { FwpmFilterAdd0(engine.0, &filter, access.0, std::ptr::null_mut()) },
                "FwpmFilterAdd0",
            )?;
        }
        Ok(())
    }

    pub(super) fn verify(&self, accounts: &[Account]) -> Result<()> {
        let engine = Engine::open()?;
        for plan in &self.filters {
            let account = accounts
                .get(plan.account)
                .ok_or("invalid account in network plan")?;
            let mut filter = std::ptr::null_mut();
            check(
                unsafe { FwpmFilterGetByKey0(engine.0, &guid(plan.key), &mut filter) },
                "FwpmFilterGetByKey0",
            )?;
            let valid = unsafe { !filter.is_null() && self.matches(&*filter, plan, account) };
            unsafe {
                FwpmFreeMemory0((&mut filter as *mut *mut FWPM_FILTER0).cast());
            }
            if !valid {
                return Err(
                    "the installed Ash network rules do not match the approved plan".into(),
                );
            }
        }
        Ok(())
    }

    unsafe fn matches(&self, filter: &FWPM_FILTER0, plan: &Filter, account: &Account) -> bool {
        unsafe {
            if !same_guid(&filter.subLayerKey, &guid(self.sublayer))
                || !same_guid(&filter.layerKey, &plan.layer.key())
                || filter.providerKey.is_null()
                || !same_guid(&*filter.providerKey, &guid(self.provider))
                || filter.flags != FWPM_FILTER_FLAG_PERSISTENT
                || filter.action.r#type != plan.action.value()
                || filter.weight.r#type != FWP_UINT8
                || filter.weight.Anonymous.uint8 != plan.action.weight()
            {
                return false;
            }
            let expected_count = match plan.action {
                Action::Block => 1,
                Action::Proxy => 4,
            };
            if filter.numFilterConditions != expected_count || filter.filterCondition.is_null() {
                return false;
            }
            let actual =
                std::slice::from_raw_parts(filter.filterCondition, expected_count as usize);
            let Some(user) = actual
                .iter()
                .find(|value| same_guid(&value.fieldKey, &FWPM_CONDITION_ALE_USER_ID))
            else {
                return false;
            };
            if user.matchType != FWP_MATCH_EQUAL
                || user.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
            {
                return false;
            }
            let blob = user.conditionValue.Anonymous.sd;
            if blob.is_null()
                || (*blob).data.is_null()
                || !matches_user((*blob).data.cast(), &account.sid)
            {
                return false;
            }
            if matches!(plan.action, Action::Proxy) {
                for (key, kind, value) in [
                    (FWPM_CONDITION_IP_REMOTE_ADDRESS, FWP_UINT32, 0x7f000001),
                    (FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, 6),
                    (
                        FWPM_CONDITION_IP_REMOTE_PORT,
                        FWP_UINT16,
                        account.proxy_port as u32,
                    ),
                ] {
                    let Some(condition) = actual
                        .iter()
                        .find(|condition| same_guid(&condition.fieldKey, &key))
                    else {
                        return false;
                    };
                    if condition.matchType != FWP_MATCH_EQUAL
                        || condition.conditionValue.r#type != kind
                    {
                        return false;
                    }
                    let got = match kind {
                        FWP_UINT8 => condition.conditionValue.Anonymous.uint8 as u32,
                        FWP_UINT16 => condition.conditionValue.Anonymous.uint16 as u32,
                        _ => condition.conditionValue.Anonymous.uint32,
                    };
                    if got != value {
                        return false;
                    }
                }
            }
            true
        }
    }

    pub(super) fn remove(&self) -> Result<()> {
        use windows_sys::Win32::Foundation::FWP_E_FILTER_NOT_FOUND;
        use windows_sys::Win32::Foundation::FWP_E_PROVIDER_NOT_FOUND;
        use windows_sys::Win32::Foundation::FWP_E_SUBLAYER_NOT_FOUND;
        let engine = Engine::open()?;
        for plan in &self.filters {
            let status = unsafe { FwpmFilterDeleteByKey0(engine.0, &guid(plan.key)) };
            if status != FWP_E_FILTER_NOT_FOUND as u32 {
                check(status, "FwpmFilterDeleteByKey0")?;
            }
        }
        let status = unsafe { FwpmSubLayerDeleteByKey0(engine.0, &guid(self.sublayer)) };
        if status != FWP_E_SUBLAYER_NOT_FOUND as u32 {
            check(status, "FwpmSubLayerDeleteByKey0")?;
        }
        let status = unsafe { FwpmProviderDeleteByKey0(engine.0, &guid(self.provider)) };
        if status != FWP_E_PROVIDER_NOT_FOUND as u32 {
            check(status, "FwpmProviderDeleteByKey0")?;
        }
        // Independently read back every recorded key. A successful delete call
        // alone is not the final cleanup assertion.
        for plan in &self.filters {
            let mut filter = std::ptr::null_mut();
            let status = unsafe { FwpmFilterGetByKey0(engine.0, &guid(plan.key), &mut filter) };
            if !filter.is_null() {
                unsafe {
                    FwpmFreeMemory0((&mut filter as *mut *mut FWPM_FILTER0).cast());
                }
            }
            if status != FWP_E_FILTER_NOT_FOUND as u32 {
                return Err(
                    "an Ash filter still exists or could not be checked after removal".into(),
                );
            }
        }
        let mut sublayer = std::ptr::null_mut();
        let status =
            unsafe { FwpmSubLayerGetByKey0(engine.0, &guid(self.sublayer), &mut sublayer) };
        if !sublayer.is_null() {
            unsafe {
                FwpmFreeMemory0((&mut sublayer as *mut *mut FWPM_SUBLAYER0).cast());
            }
        }
        if status != FWP_E_SUBLAYER_NOT_FOUND as u32 {
            return Err(
                "the Ash sublayer still exists or could not be checked after removal".into(),
            );
        }
        let mut provider = std::ptr::null_mut();
        let status =
            unsafe { FwpmProviderGetByKey0(engine.0, &guid(self.provider), &mut provider) };
        if !provider.is_null() {
            unsafe {
                FwpmFreeMemory0((&mut provider as *mut *mut FWPM_PROVIDER0).cast());
            }
        }
        if status != FWP_E_PROVIDER_NOT_FOUND as u32 {
            return Err(
                "the Ash provider still exists or could not be checked after removal".into(),
            );
        }
        Ok(())
    }
}

fn conditions(
    account: &Account,
    action: Action,
    user: *mut FWP_BYTE_BLOB,
) -> Vec<FWPM_FILTER_CONDITION0> {
    let mut result = vec![FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_ALE_USER_ID,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
            Anonymous: FWP_CONDITION_VALUE0_0 { sd: user },
        },
    }];
    if matches!(action, Action::Proxy) {
        result.extend([
            FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT32,
                    Anonymous: FWP_CONDITION_VALUE0_0 { uint32: 0x7f000001 },
                },
            },
            FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_PROTOCOL,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT8,
                    Anonymous: FWP_CONDITION_VALUE0_0 { uint8: 6 },
                },
            },
            FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT16,
                    Anonymous: FWP_CONDITION_VALUE0_0 {
                        uint16: account.proxy_port,
                    },
                },
            },
        ]);
    }
    result
}

unsafe fn matches_user(descriptor: *mut std::ffi::c_void, expected: &str) -> bool {
    unsafe {
        use windows_sys::Win32::Security::*;
        let mut dacl = std::ptr::null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0
            || present == 0
            || dacl.is_null()
            || (*dacl).AceCount != 1
        {
            return false;
        }
        let mut raw = std::ptr::null_mut();
        if GetAce(dacl, 0, &mut raw) == 0 || raw.is_null() {
            return false;
        }
        let ace = &*raw.cast::<ACCESS_ALLOWED_ACE>();
        if ace.Header.AceType
            != windows::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE as u8
            || ace.Header.AceFlags != 0
            || ace.Mask != 1
        {
            return false;
        }
        let Ok(sid) = win::sid(expected) else {
            return false;
        };
        EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid.0) != 0
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
