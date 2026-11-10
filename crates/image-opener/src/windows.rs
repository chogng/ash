#![allow(unsafe_code)]

use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::ptr;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::DeleteObject;
use windows::Win32::Graphics::Imaging::CLSID_WICImagingFactory;
use windows::Win32::Graphics::Imaging::GUID_WICPixelFormat32bppRGBA;
use windows::Win32::Graphics::Imaging::IWICBitmap;
use windows::Win32::Graphics::Imaging::IWICImagingFactory;
use windows::Win32::Graphics::Imaging::WICBitmapDitherTypeNone;
use windows::Win32::Graphics::Imaging::WICBitmapPaletteTypeCustom;
use windows::Win32::Graphics::Imaging::WICBitmapUsePremultipliedAlpha;
use windows::Win32::System::Com::CLSCTX_INPROC_SERVER;
use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
use windows::Win32::System::Com::COINIT_DISABLE_OLE1DDE;
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::System::Com::CoInitializeEx;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::CoUninitialize;
use windows::Win32::System::Com::IDataObject;
use windows::Win32::UI::Shell::AL_EFFECTIVE;
use windows::Win32::UI::Shell::ASSOC_FILTER_RECOMMENDED;
use windows::Win32::UI::Shell::ASSOCF_INIT_IGNOREUNKNOWN;
use windows::Win32::UI::Shell::ASSOCF_NOTRUNCATE;
use windows::Win32::UI::Shell::ASSOCSTR;
use windows::Win32::UI::Shell::ASSOCSTR_APPICONREFERENCE;
use windows::Win32::UI::Shell::ASSOCSTR_APPID;
use windows::Win32::UI::Shell::ASSOCSTR_EXECUTABLE;
use windows::Win32::UI::Shell::ASSOCSTR_FRIENDLYAPPNAME;
use windows::Win32::UI::Shell::ASSOCSTR_PROGID;
use windows::Win32::UI::Shell::AT_FILEEXTENSION;
use windows::Win32::UI::Shell::ApplicationAssociationRegistration;
use windows::Win32::UI::Shell::AssocQueryStringW;
use windows::Win32::UI::Shell::BHID_DataObject;
use windows::Win32::UI::Shell::FOLDERID_AppsFolder;
use windows::Win32::UI::Shell::IApplicationAssociationRegistration;
use windows::Win32::UI::Shell::IAssocHandler;
use windows::Win32::UI::Shell::IObjectWithAppUserModelID;
use windows::Win32::UI::Shell::IObjectWithProgID;
use windows::Win32::UI::Shell::IShellItem;
use windows::Win32::UI::Shell::IShellItemImageFactory;
use windows::Win32::UI::Shell::KNOWN_FOLDER_FLAG;
use windows::Win32::UI::Shell::SHAssocEnumHandlers;
use windows::Win32::UI::Shell::SHCreateItemFromParsingName;
use windows::Win32::UI::Shell::SHCreateItemInKnownFolder;
use windows::Win32::UI::Shell::SHDefExtractIconW;
use windows::Win32::UI::Shell::SIGDN_NORMALDISPLAY;
use windows::Win32::UI::Shell::SIIGBF_ICONONLY;
use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;
use windows::Win32::UI::WindowsAndMessaging::HICON;
use windows::core::HSTRING;
use windows::core::Interface;
use windows::core::PCWSTR;
use windows::core::PWSTR;

use crate::association::Association;

const ICON_SIZE: u32 = 36;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Application {
    id: String,
    name: String,
    is_default: bool,
    icon: Option<String>,
}

struct Handler {
    native: IAssocHandler,
    id: String,
    name: String,
    association: Association,
}

impl Handler {
    fn read(native: IAssocHandler) -> Option<Self> {
        // Shell-owned strings returned by these interfaces use the COM allocator.
        let name = take_string(unsafe { native.GetUIName() }.ok()?)?;
        let target = unsafe { native.GetName() }.ok().and_then(take_string);
        let prog_id = native
            .cast::<IObjectWithProgID>()
            .ok()
            .and_then(|object| take_string(unsafe { object.GetProgID() }.ok()?));
        let app_id = native
            .cast::<IObjectWithAppUserModelID>()
            .ok()
            .and_then(|object| take_string(unsafe { object.GetAppID() }.ok()?));
        // Re-enumerate by identity when opening. Menu ordering can change after discovery.
        let identity = app_id
            .as_deref()
            .or(prog_id.as_deref())
            .or(target.as_deref())?;
        let id = format!("win-{:x}", Sha256::digest(identity.to_lowercase()));
        Some(Self {
            native,
            id,
            name,
            association: Association {
                prog_id,
                app_id,
                target,
            },
        })
    }

    fn icon(&self, factory: &IWICImagingFactory) -> Option<String> {
        self.association
            .app_id
            .as_deref()
            .and_then(|id| app_icon(factory, id))
            .or_else(|| {
                let mut path = PWSTR::null();
                let mut index = 0;
                let result = unsafe { self.native.GetIconLocation(&mut path, &mut index) };
                let path = take_string(path);
                result.ok()?;
                resource_icon(factory, &path?, index)
            })
            .or_else(|| {
                self.association
                    .target
                    .as_deref()
                    .and_then(|path| executable_icon(factory, path))
            })
    }
}

pub(super) fn run() -> Result<(), Box<dyn Error>> {
    process_hardening::initialize()?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let _apartment = Apartment::enter()?;
    match args.as_slice() {
        [mode, extension] if mode == "list" => {
            let extension = image_extension(extension)?;
            serde_json::to_writer(io::stdout().lock(), &applications(&extension))?;
        }
        [mode, path, id] if mode == "open" => {
            let path = Path::new(path);
            let extension = image_extension(path.extension().ok_or("Missing image extension")?)?;
            let id = id.to_str().ok_or("Invalid application ID")?;
            let handler = handlers(&extension)?
                .into_iter()
                .find(|handler| handler.id == id)
                .ok_or("The selected application is no longer available for this image")?;
            let item: IShellItem =
                unsafe { SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)? };
            let data: IDataObject = unsafe { item.BindToHandler(None, &BHID_DataObject)? };
            unsafe { handler.native.Invoke(&data)? };
        }
        _ => return Err("Expected list <extension> or open <image path> <application ID>".into()),
    }
    Ok(())
}

fn image_extension(extension: &OsStr) -> Result<HSTRING, Box<dyn Error>> {
    match extension.to_str() {
        Some("png") => Ok(HSTRING::from(".png")),
        Some("jpg") => Ok(HSTRING::from(".jpg")),
        Some("gif") => Ok(HSTRING::from(".gif")),
        Some("webp") => Ok(HSTRING::from(".webp")),
        _ => Err("Unsupported image format".into()),
    }
}

fn handlers(extension: &HSTRING) -> windows::core::Result<Vec<Handler>> {
    let enumerator = unsafe { SHAssocEnumHandlers(extension, ASSOC_FILTER_RECOMMENDED)? };
    let mut handlers = Vec::new();
    loop {
        let mut next = [None];
        unsafe { enumerator.Next(&mut next, None)? };
        let Some(native) = next[0].take() else {
            return Ok(handlers);
        };
        handlers.extend(Handler::read(native));
    }
}

fn applications(extension: &HSTRING) -> Vec<Application> {
    let system_default = Association {
        prog_id: default_prog_id(extension).or_else(|| association(extension, ASSOCSTR_PROGID)),
        app_id: association(extension, ASSOCSTR_APPID),
        target: association(extension, ASSOCSTR_EXECUTABLE),
    };
    // The current association remains usable when the Shell has no recommended handlers.
    let mut handlers = handlers(extension).unwrap_or_default();
    let default = system_default.default_index(handlers.iter().map(|handler| &handler.association));
    if let Some(index) = default {
        // Preserve the Shell's ordering for the remaining handlers.
        let handler = handlers.remove(index);
        handlers.insert(0, handler);
    }

    let factory: Option<IWICImagingFactory> =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok() };
    let default_icon = |factory: &IWICImagingFactory| {
        system_default
            .app_id
            .as_deref()
            .and_then(|id| app_icon(factory, id))
            .or_else(|| {
                let reference = association(extension, ASSOCSTR_APPICONREFERENCE)?;
                let (path, index) = reference
                    .rsplit_once(',')
                    .and_then(|(path, index)| Some((path, index.trim().parse().ok()?)))
                    .unwrap_or((&reference, 0));
                resource_icon(factory, path.trim_matches('"'), index)
            })
            .or_else(|| {
                system_default
                    .target
                    .as_deref()
                    .and_then(|path| executable_icon(factory, path))
            })
    };
    let mut applications = Vec::new();
    if default.is_none()
        && let Some(name) = system_default
            .app_id
            .as_deref()
            .and_then(app_display_name)
            .or_else(|| association(extension, ASSOCSTR_FRIENDLYAPPNAME))
    {
        // The effective default can exist outside the recommended Open With list.
        // This row uses the normal system open path, without a handler ID.
        let icon = factory.as_ref().and_then(default_icon);
        applications.push(Application {
            id: "default".into(),
            name,
            is_default: true,
            icon,
        });
    }
    let mut ids = HashSet::new();
    for (index, handler) in handlers.into_iter().enumerate() {
        if ids.insert(handler.id.clone()) {
            let is_default = default.is_some() && index == 0;
            let icon = factory.as_ref().and_then(|factory| {
                handler
                    .icon(factory)
                    .or_else(|| is_default.then(|| default_icon(factory)).flatten())
            });
            applications.push(Application {
                id: handler.id,
                name: handler.name,
                is_default,
                icon,
            });
        }
    }
    applications
}

fn default_prog_id(extension: &HSTRING) -> Option<String> {
    let registration: IApplicationAssociationRegistration = unsafe {
        CoCreateInstance(
            &ApplicationAssociationRegistration,
            None,
            CLSCTX_INPROC_SERVER,
        )
        .ok()?
    };
    take_string(
        unsafe { registration.QueryCurrentDefault(extension, AT_FILEEXTENSION, AL_EFFECTIVE) }
            .ok()?,
    )
}

fn association(extension: &HSTRING, kind: ASSOCSTR) -> Option<String> {
    let mut buffer = [0u16; 4096];
    let mut len = buffer.len() as u32;
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_IGNOREUNKNOWN | ASSOCF_NOTRUNCATE,
            kind,
            extension,
            PCWSTR::null(),
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut len,
        )
    };
    if result.is_err() {
        return None;
    }
    let text = String::from_utf16(buffer.split(|c| *c == 0).next()?).ok()?;
    (!text.is_empty()).then_some(text)
}

fn take_string(value: PWSTR) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let text = unsafe { value.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    text.filter(|text| !text.trim().is_empty())
}

fn app_item(app_id: &str) -> Option<IShellItem> {
    unsafe {
        SHCreateItemInKnownFolder(
            &FOLDERID_AppsFolder,
            KNOWN_FOLDER_FLAG(0),
            &HSTRING::from(app_id),
        )
        .ok()
    }
}

fn app_display_name(app_id: &str) -> Option<String> {
    let item = app_item(app_id)?;
    take_string(unsafe { item.GetDisplayName(SIGDN_NORMALDISPLAY) }.ok()?)
}

fn app_icon(factory: &IWICImagingFactory, app_id: &str) -> Option<String> {
    let item = app_item(app_id)?.cast::<IShellItemImageFactory>().ok()?;
    let size = SIZE {
        cx: ICON_SIZE as i32,
        cy: ICON_SIZE as i32,
    };
    let bitmap = unsafe { item.GetImage(size, SIIGBF_ICONONLY).ok()? };
    let source = unsafe {
        factory.CreateBitmapFromHBITMAP(bitmap, Default::default(), WICBitmapUsePremultipliedAlpha)
    };
    let png = source
        .ok()
        .and_then(|source| encode_icon(factory, &source).ok());
    let _ = unsafe { DeleteObject(bitmap.into()) };
    png
}

fn executable_icon(factory: &IWICImagingFactory, executable: &str) -> Option<String> {
    Path::new(executable)
        .is_absolute()
        .then(|| resource_icon(factory, executable, 0))
        .flatten()
}

fn resource_icon(factory: &IWICImagingFactory, path: &str, index: i32) -> Option<String> {
    let mut icon = HICON::default();
    let result = unsafe {
        SHDefExtractIconW(
            &HSTRING::from(path),
            index,
            0,
            Some(&mut icon),
            None,
            ICON_SIZE,
        )
    };
    if icon.is_invalid() {
        return None;
    }
    let png = if result.is_ok() {
        unsafe { factory.CreateBitmapFromHICON(icon) }
            .ok()
            .and_then(|source| encode_icon(factory, &source).ok())
    } else {
        None
    };
    let _ = unsafe { DestroyIcon(icon) };
    png
}

fn encode_icon(
    factory: &IWICImagingFactory,
    source: &IWICBitmap,
) -> Result<String, Box<dyn Error>> {
    let (mut width, mut height) = (0, 0);
    unsafe { source.GetSize(&mut width, &mut height)? };
    if width == 0 || height == 0 || width > 128 || height > 128 {
        return Err("Invalid application icon dimensions".into());
    }
    let converter = unsafe { factory.CreateFormatConverter()? };
    unsafe {
        converter.Initialize(
            source,
            &GUID_WICPixelFormat32bppRGBA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
    }
    let mut pixels = vec![0; (width * height * 4) as usize];
    unsafe { converter.CopyPixels(ptr::null(), width * 4, &mut pixels)? };
    let mut png = Vec::new();
    PngEncoder::new(&mut png).write_image(
        &pixels,
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )?;
    Ok(STANDARD.encode(png))
}

struct Apartment;

impl Apartment {
    fn enter() -> windows::core::Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}
