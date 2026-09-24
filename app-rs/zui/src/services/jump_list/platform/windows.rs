#![allow(unsafe_code)]

use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use std::path::PathBuf;
use std::ptr;

use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_IsDestListSeparator;
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::CLSCTX_INPROC_SERVER;
use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::System::Com::CoInitializeEx;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::CoUninitialize;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::UI::Shell::Common::IObjectArray;
use windows::Win32::UI::Shell::Common::IObjectCollection;
use windows::Win32::UI::Shell::DestinationList;
use windows::Win32::UI::Shell::EnumerableObjectCollection;
use windows::Win32::UI::Shell::GetCurrentProcessExplicitAppUserModelID;
use windows::Win32::UI::Shell::ICustomDestinationList;
use windows::Win32::UI::Shell::IShellItem;
use windows::Win32::UI::Shell::IShellLinkW;
use windows::Win32::UI::Shell::KDC_FREQUENT;
use windows::Win32::UI::Shell::KDC_RECENT;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::SHCreateItemFromParsingName;
use windows::Win32::UI::Shell::SIGDN_FILESYSPATH;
use windows::Win32::UI::Shell::ShellLink;
use windows::core::BSTR;
use windows::core::Interface;
use windows::core::PCWSTR;

use super::super::JUMP_LIST;
use super::super::JumpListCategory;
use super::super::JumpListItem;
use super::super::JumpListRequest;
use super::super::JumpListSettings;
use super::super::JumpListTask;
use super::super::JumpListUpdateResult;
use crate::services::SystemServiceError;

const DESTS_E_NO_MATCHING_ASSOC_HANDLER: i32 = 0x80040F03_u32 as i32;
const PATH_BUFFER_SIZE: usize = 32_768;

pub(super) fn settings() -> Result<JumpListSettings, SystemServiceError> {
    let _apartment = ComApartment::enter()?;
    let (transaction, min_items, removed) = JumpListTransaction::begin()?;
    let removed_items = read_removed_items(&removed)?;
    transaction.abort()?;
    Ok(JumpListSettings::new(min_items, removed_items))
}

pub(super) fn set(request: &JumpListRequest) -> Result<JumpListUpdateResult, SystemServiceError> {
    let _apartment = ComApartment::enter()?;
    match request {
        JumpListRequest::Default => reset(),
        JumpListRequest::Categories(categories) => replace(categories),
    }
}

fn reset() -> Result<JumpListUpdateResult, SystemServiceError> {
    let destinations = destination_list()?;
    let app_id = ProcessAppId::current();
    // SAFETY: The optional process AppUserModelID stays allocated for this synchronous call. A
    // null value asks current Windows versions to infer the calling process identity.
    unsafe { destinations.DeleteList(app_id.as_pcwstr()) }
        .map_err(|source| windows_error("ICustomDestinationList::DeleteList", source))?;
    Ok(JumpListUpdateResult::Applied)
}

fn replace(categories: &[JumpListCategory]) -> Result<JumpListUpdateResult, SystemServiceError> {
    let (transaction, _, _) = JumpListTransaction::begin()?;
    for category in categories {
        match append_category(transaction.destinations(), category) {
            Ok(()) => {}
            Err(AppendFailure::FileTypeRegistrationRequired) => {
                return Ok(JumpListUpdateResult::FileTypeRegistrationRequired);
            }
            Err(AppendFailure::CustomCategoriesDisabled) => {
                return Ok(JumpListUpdateResult::CustomCategoriesDisabled);
            }
            Err(AppendFailure::Backend(error)) => return Err(error),
        }
    }
    transaction.commit()?;
    Ok(JumpListUpdateResult::Applied)
}

struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    fn enter() -> Result<Self, SystemServiceError> {
        // SAFETY: This initializes COM for the current application thread and is balanced by
        // `Drop`. An existing apartment with another model remains usable and untouched.
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result.is_err() && result != RPC_E_CHANGED_MODE {
            return Err(SystemServiceError::backend(
                JUMP_LIST,
                std::io::Error::other(format!("CoInitializeEx failed: {result}")),
            ));
        }
        Ok(Self {
            initialized: result.is_ok(),
        })
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: This balances the successful initialization on the same thread.
            unsafe { CoUninitialize() };
        }
    }
}

struct ProcessAppId(Option<windows::core::PWSTR>);

impl ProcessAppId {
    fn current() -> Self {
        // SAFETY: Windows allocates the returned explicit identity with COM task memory. Failure
        // simply means the Shell should infer the process identity.
        Self(unsafe { GetCurrentProcessExplicitAppUserModelID() }.ok())
    }

    fn as_pcwstr(&self) -> PCWSTR {
        self.0
            .as_ref()
            .map_or(PCWSTR::null(), |value| PCWSTR(value.0))
    }
}

impl Drop for ProcessAppId {
    fn drop(&mut self) {
        if let Some(value) = self.0.take() {
            // SAFETY: The pointer came from `GetCurrentProcessExplicitAppUserModelID` and has not
            // been freed or transferred.
            unsafe { CoTaskMemFree(Some(value.0.cast())) };
        }
    }
}

struct JumpListTransaction {
    destinations: ICustomDestinationList,
    active: bool,
}

impl JumpListTransaction {
    fn begin() -> Result<(Self, u32, IObjectArray), SystemServiceError> {
        let destinations = destination_list()?;
        let app_id = ProcessAppId::current();
        if !app_id.as_pcwstr().is_null() {
            // SAFETY: The explicit process identity remains alive for the synchronous setter.
            unsafe { destinations.SetAppID(app_id.as_pcwstr()) }
                .map_err(|source| windows_error("ICustomDestinationList::SetAppID", source))?;
        }
        let mut min_items = 0;
        // SAFETY: `min_items` is a valid output slot and the requested interface is IObjectArray.
        let removed = unsafe { destinations.BeginList::<IObjectArray>(&mut min_items) }
            .map_err(|source| windows_error("ICustomDestinationList::BeginList", source))?;
        Ok((
            Self {
                destinations,
                active: true,
            },
            min_items,
            removed,
        ))
    }

    fn destinations(&self) -> &ICustomDestinationList {
        &self.destinations
    }

    fn commit(mut self) -> Result<(), SystemServiceError> {
        // SAFETY: `begin` established one active transaction on this interface.
        unsafe { self.destinations.CommitList() }
            .map_err(|source| windows_error("ICustomDestinationList::CommitList", source))?;
        self.active = false;
        Ok(())
    }

    fn abort(mut self) -> Result<(), SystemServiceError> {
        // SAFETY: `begin` established one active transaction on this interface.
        unsafe { self.destinations.AbortList() }
            .map_err(|source| windows_error("ICustomDestinationList::AbortList", source))?;
        self.active = false;
        Ok(())
    }
}

impl Drop for JumpListTransaction {
    fn drop(&mut self) {
        if self.active {
            // SAFETY: This best-effort cleanup abandons the still-active transaction.
            let _ = unsafe { self.destinations.AbortList() };
        }
    }
}

fn destination_list() -> Result<ICustomDestinationList, SystemServiceError> {
    // SAFETY: CLSID_DestinationList is an in-process Windows implementation of the requested
    // ICustomDestinationList interface.
    unsafe { CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER) }
        .map_err(|source| windows_error("CoCreateInstance(ICustomDestinationList)", source))
}

enum AppendFailure {
    FileTypeRegistrationRequired,
    CustomCategoriesDisabled,
    Backend(SystemServiceError),
}

fn append_category(
    destinations: &ICustomDestinationList,
    category: &JumpListCategory,
) -> Result<(), AppendFailure> {
    match category {
        JumpListCategory::Frequent => {
            // SAFETY: The transaction is active and this is a Windows-managed category constant.
            unsafe { destinations.AppendKnownCategory(KDC_FREQUENT) }
                .map_err(|source| backend_failure("AppendKnownCategory(Frequent)", source))
        }
        JumpListCategory::Recent => {
            // SAFETY: The transaction is active and this is a Windows-managed category constant.
            unsafe { destinations.AppendKnownCategory(KDC_RECENT) }
                .map_err(|source| backend_failure("AppendKnownCategory(Recent)", source))
        }
        JumpListCategory::Tasks(items) => {
            let Some(items) = build_collection(items)? else {
                return Ok(());
            };
            // SAFETY: The transaction is active and `items` owns a valid IObjectArray.
            unsafe { destinations.AddUserTasks(&items) }
                .map_err(|source| backend_failure("ICustomDestinationList::AddUserTasks", source))
        }
        JumpListCategory::Custom { name, items } => {
            let Some(items) = build_collection(items)? else {
                return Ok(());
            };
            let name = wide_text(name);
            // SAFETY: The transaction is active; the name is nul-terminated and both arguments
            // stay alive throughout the synchronous call.
            match unsafe { destinations.AppendCategory(PCWSTR(name.as_ptr()), &items) } {
                Ok(()) => Ok(()),
                Err(source) if source.code().0 == DESTS_E_NO_MATCHING_ASSOC_HANDLER => {
                    Err(AppendFailure::FileTypeRegistrationRequired)
                }
                Err(source) if source.code() == E_ACCESSDENIED => {
                    Err(AppendFailure::CustomCategoriesDisabled)
                }
                Err(source) => Err(backend_failure(
                    "ICustomDestinationList::AppendCategory",
                    source,
                )),
            }
        }
    }
}

fn build_collection(items: &[JumpListItem]) -> Result<Option<IObjectArray>, AppendFailure> {
    if items.is_empty() {
        return Ok(None);
    }
    // SAFETY: CLSID_EnumerableObjectCollection is an in-process Windows implementation of the
    // requested IObjectCollection interface.
    let collection: IObjectCollection =
        unsafe { CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER) }
            .map_err(|source| backend_failure("CoCreateInstance(IObjectCollection)", source))?;
    for item in items {
        match item {
            JumpListItem::Task(task) => append_task(&collection, task)?,
            JumpListItem::Separator => append_separator(&collection)?,
            JumpListItem::File(path) => append_file(&collection, path)?,
        }
    }
    collection
        .cast::<IObjectArray>()
        .map(Some)
        .map_err(|source| backend_failure("IObjectCollection::QueryInterface", source))
}

fn append_task(collection: &IObjectCollection, task: &JumpListTask) -> Result<(), AppendFailure> {
    // SAFETY: CLSID_ShellLink is an in-process Windows implementation of IShellLinkW.
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
        .map_err(|source| backend_failure("CoCreateInstance(IShellLinkW)", source))?;
    let program = wide_path(task.program());
    let arguments = wide_text(task.arguments());
    let description = wide_text(task.description());
    // SAFETY: Each vector is nul-terminated and remains alive for its synchronous setter call.
    unsafe {
        link.SetPath(PCWSTR(program.as_ptr()))
            .and_then(|()| link.SetArguments(PCWSTR(arguments.as_ptr())))
            .and_then(|()| link.SetDescription(PCWSTR(description.as_ptr())))
    }
    .map_err(|source| backend_failure("IShellLinkW task properties", source))?;
    if let Some(directory) = task.working_directory() {
        let directory = wide_path(directory);
        // SAFETY: The path is nul-terminated and stays alive for the call.
        unsafe { link.SetWorkingDirectory(PCWSTR(directory.as_ptr())) }
            .map_err(|source| backend_failure("IShellLinkW::SetWorkingDirectory", source))?;
    }
    if let Some((path, index)) = task.icon() {
        let path = wide_path(path);
        // SAFETY: The path is nul-terminated and stays alive for the call.
        unsafe { link.SetIconLocation(PCWSTR(path.as_ptr()), index) }
            .map_err(|source| backend_failure("IShellLinkW::SetIconLocation", source))?;
    }
    let property_store = link
        .cast::<IPropertyStore>()
        .map_err(|source| backend_failure("IShellLinkW::IPropertyStore", source))?;
    let title = PROPVARIANT::from(task.title());
    // SAFETY: The property key and variant are valid and remain alive through the calls.
    unsafe {
        property_store
            .SetValue(&PKEY_Title, &title)
            .and_then(|()| property_store.Commit())
            .and_then(|()| collection.AddObject(&link))
    }
    .map_err(|source| backend_failure("append Jump List task", source))
}

fn append_separator(collection: &IObjectCollection) -> Result<(), AppendFailure> {
    // SAFETY: CLSID_ShellLink is an in-process Windows implementation of IShellLinkW.
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
        .map_err(|source| backend_failure("CoCreateInstance(separator IShellLinkW)", source))?;
    let property_store = link
        .cast::<IPropertyStore>()
        .map_err(|source| backend_failure("separator IPropertyStore", source))?;
    let separator = PROPVARIANT::from(true);
    // SAFETY: The property key and variant are valid and remain alive through the calls.
    unsafe {
        property_store
            .SetValue(&PKEY_AppUserModel_IsDestListSeparator, &separator)
            .and_then(|()| property_store.Commit())
            .and_then(|()| collection.AddObject(&link))
    }
    .map_err(|source| backend_failure("append Jump List separator", source))
}

fn append_file(collection: &IObjectCollection, path: &Path) -> Result<(), AppendFailure> {
    let path = wide_path(path);
    // SAFETY: The absolute path is nul-terminated, no bind context is needed, and the requested
    // interface is IShellItem.
    let item: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None) }
        .map_err(|source| backend_failure("SHCreateItemFromParsingName", source))?;
    // SAFETY: `item` owns a live IShellItem for the duration of the collection call.
    unsafe { collection.AddObject(&item) }
        .map_err(|source| backend_failure("append Jump List file", source))
}

fn read_removed_items(array: &IObjectArray) -> Result<Vec<JumpListItem>, SystemServiceError> {
    // SAFETY: `array` is the live removed-destination array returned by BeginList.
    let count = unsafe { array.GetCount() }
        .map_err(|source| windows_error("IObjectArray::GetCount", source))?;
    let mut items = Vec::with_capacity(count as usize);
    for index in 0..count {
        // SAFETY: `index` is within the count returned by this same array.
        if let Ok(item) = unsafe { array.GetAt::<IShellItem>(index) }
            && let Some(path) = shell_item_path(&item)
        {
            items.push(JumpListItem::File(path));
            continue;
        }
        // SAFETY: Querying an alternative interface for the same valid array slot is supported.
        if let Ok(link) = unsafe { array.GetAt::<IShellLinkW>(index) }
            && let Some(task) = shell_link_task(&link)
        {
            items.push(JumpListItem::Task(task));
        }
    }
    Ok(items)
}

fn shell_item_path(item: &IShellItem) -> Option<PathBuf> {
    // SAFETY: The returned pointer is COM task memory and is transferred to `take_com_path`.
    let path = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.ok()?;
    take_com_path(path)
}

fn take_com_path(path: windows::core::PWSTR) -> Option<PathBuf> {
    if path.is_null() {
        return None;
    }
    // SAFETY: The Shell returned a valid nul-terminated UTF-16 buffer. We scan it once, copy it
    // into an owned OsString, then release the original COM task allocation exactly once.
    let value = unsafe {
        let mut length = 0;
        while *path.0.add(length) != 0 {
            length += 1;
        }
        let value = OsString::from_wide(std::slice::from_raw_parts(path.0, length));
        CoTaskMemFree(Some(path.0.cast()));
        value
    };
    Some(PathBuf::from(value))
}

fn shell_link_task(link: &IShellLinkW) -> Option<JumpListTask> {
    let mut program = vec![0_u16; PATH_BUFFER_SIZE];
    // SAFETY: The output buffer is writable and no WIN32_FIND_DATA is requested.
    unsafe { link.GetPath(&mut program, ptr::null_mut(), 0) }.ok()?;
    let program = path_from_buffer(&program)?;
    let mut title = String::new();
    if let Ok(store) = link.cast::<IPropertyStore>()
        // SAFETY: `store` is live and the title property key is valid.
        && let Ok(value) = unsafe { store.GetValue(&PKEY_Title) }
        && let Ok(value) = BSTR::try_from(&value)
    {
        title = String::from_utf16_lossy(&value);
    }
    if title.trim().is_empty() {
        return None;
    }
    let mut arguments = vec![0_u16; PATH_BUFFER_SIZE];
    // SAFETY: The output buffer is writable for the duration of the call.
    let arguments = unsafe { link.GetArguments(&mut arguments) }
        .ok()
        .map(|()| text_from_buffer(&arguments))
        .unwrap_or_default();
    let mut description = vec![0_u16; 1_024];
    // SAFETY: The output buffer is writable for the duration of the call.
    let description = unsafe { link.GetDescription(&mut description) }
        .ok()
        .map(|()| text_from_buffer(&description))
        .unwrap_or_default();
    let mut task = JumpListTask::new(program, title)
        .with_arguments(arguments)
        .with_description(description);
    let mut directory = vec![0_u16; PATH_BUFFER_SIZE];
    // SAFETY: The output buffer is writable for the duration of the call.
    if unsafe { link.GetWorkingDirectory(&mut directory) }.is_ok()
        && let Some(directory) = path_from_buffer(&directory)
        && directory.is_absolute()
    {
        task = task.with_working_directory(directory);
    }
    let mut icon = vec![0_u16; PATH_BUFFER_SIZE];
    let mut icon_index = 0;
    // SAFETY: Both output slots are writable for the duration of the call.
    if unsafe { link.GetIconLocation(&mut icon, &mut icon_index) }.is_ok()
        && let Some(icon) = path_from_buffer(&icon)
        && icon.is_absolute()
    {
        task = task.with_icon(icon, icon_index);
    }
    Some(task)
}

fn path_from_buffer(buffer: &[u16]) -> Option<PathBuf> {
    let length = buffer.iter().position(|value| *value == 0)?;
    if length == 0 {
        return None;
    }
    Some(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

fn text_from_buffer(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn wide_text(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn backend_failure(operation: &'static str, source: windows::core::Error) -> AppendFailure {
    AppendFailure::Backend(windows_error(operation, source))
}

fn windows_error(operation: &str, source: windows::core::Error) -> SystemServiceError {
    SystemServiceError::backend(
        JUMP_LIST,
        std::io::Error::other(format!("{operation} failed: {source}")),
    )
}
