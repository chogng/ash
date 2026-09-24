#![allow(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::cell::RefCell;
use std::ffi::CStr;
use std::ffi::CString;
use std::fmt::Write;
use std::mem;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::Once;

use objc2::Encode;
use objc2::Encoding;
use objc2::RefEncode;
use objc2::runtime::AnyClass;
use objc2::runtime::AnyObject;
use objc2::runtime::Bool;
use objc2::runtime::Imp;
use objc2::runtime::Sel;
use objc2::sel;
use objc2_app_kit::NSApplication;
use objc2_foundation::MainThreadMarker;
use objc2_foundation::NSArray;
use objc2_foundation::NSURL;

use crate::internal::NativeEventProxy;

use super::ApplicationActivation;
use super::ProtocolScheme;
use super::ProtocolUrl;
use super::RuntimeEvent;

enum MacOSApplicationEvent {
    Activated(ApplicationActivation),
    OpenFile(PathBuf),
    OpenUrl(String),
}

type EventHandler = Box<dyn Fn(MacOSApplicationEvent)>;

thread_local! {
    static EVENT_HANDLER: RefCell<Option<EventHandler>> = RefCell::new(None);
}

static INSTALL_DELEGATE_METHODS: Once = Once::new();

/// Keeps ZUI's additions to winit's application delegate active for one native run.
pub(super) struct MacOSApplicationDelegateBridge;

impl MacOSApplicationDelegateBridge {
    pub(super) fn install<T: Send + 'static>(
        proxy: NativeEventProxy<RuntimeEvent<T>>,
        accepted_schemes: Vec<ProtocolScheme>,
    ) -> Self {
        let main_thread = MainThreadMarker::new()
            .expect("the macOS application lifecycle bridge must be installed on the main thread");
        let application = NSApplication::sharedApplication(main_thread);
        // SAFETY: winit constructs and registers its application delegate before it invokes the
        // ApplicationBuilder closure that installs this bridge.
        let delegate = unsafe { application.delegate() }
            .expect("winit must register an NSApplication delegate before ZUI starts");
        // SAFETY: ProtocolObject is represented by its underlying Objective-C object. The
        // reference remains bounded by the retained delegate returned above.
        let delegate = unsafe { &*(std::ptr::from_ref(&*delegate).cast::<AnyObject>()) };
        let delegate_class = delegate.class();
        INSTALL_DELEGATE_METHODS.call_once(|| install_delegate_methods(delegate_class));

        EVENT_HANDLER.with(|handler| {
            let mut handler = handler.borrow_mut();
            assert!(
                handler.is_none(),
                "only one macOS ZUI application lifecycle bridge may be active"
            );
            *handler = Some(Box::new(move |event| match event {
                MacOSApplicationEvent::Activated(event) => {
                    let _ = proxy.send_event(RuntimeEvent::Activated(event));
                }
                MacOSApplicationEvent::OpenFile(path) => {
                    let _ = proxy.send_event(RuntimeEvent::OpenFile(path));
                }
                MacOSApplicationEvent::OpenUrl(serialized) => {
                    if let Some(url) = accepted_protocol_url(&accepted_schemes, &serialized) {
                        let _ = proxy.send_event(RuntimeEvent::OpenUrl(url));
                    }
                }
            }));
        });
        Self
    }
}

pub(super) fn accepted_protocol_url(
    accepted_schemes: &[ProtocolScheme],
    serialized: &str,
) -> Option<ProtocolUrl> {
    ProtocolUrl::parse(serialized)
        .ok()
        .filter(|url| accepted_schemes.contains(url.scheme()))
}

impl Drop for MacOSApplicationDelegateBridge {
    fn drop(&mut self) {
        EVENT_HANDLER.with(|handler| {
            handler.borrow_mut().take();
        });
    }
}

fn install_delegate_methods(delegate_class: &'static AnyClass) {
    let open_urls = sel!(application:openURLs:);
    let reopen = sel!(applicationShouldHandleReopen:hasVisibleWindows:);
    assert!(
        !delegate_class.responds_to(open_urls),
        "winit's application delegate already handles application:openURLs:"
    );
    assert!(
        !delegate_class.responds_to(reopen),
        "winit's application delegate already handles applicationShouldHandleReopen:hasVisibleWindows:"
    );
    // SAFETY: Each callback has the Objective-C signature declared by NSApplicationDelegate for
    // its selector. The class is winit's registered delegate class and neither method exists yet.
    unsafe {
        let open_urls_implementation = mem::transmute::<
            extern "C" fn(&AnyObject, Sel, &NSApplication, &NSArray<NSURL>),
            Imp,
        >(application_open_urls);
        add_method(
            delegate_class,
            open_urls,
            open_urls_implementation,
            &Encoding::Void,
            &[NSApplication::ENCODING_REF, NSArray::<NSURL>::ENCODING_REF],
        );
        let reopen_implementation = mem::transmute::<
            extern "C" fn(&AnyObject, Sel, &NSApplication, Bool) -> Bool,
            Imp,
        >(application_should_handle_reopen);
        add_method(
            delegate_class,
            reopen,
            reopen_implementation,
            &Bool::ENCODING,
            &[NSApplication::ENCODING_REF, Bool::ENCODING],
        );
    }
}

extern "C" fn application_open_urls(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &NSApplication,
    urls: &NSArray<NSURL>,
) {
    for url in urls {
        // SAFETY: AppKit supplied a live NSURL in the callback array.
        if unsafe { url.isFileURL() } {
            // SAFETY: fileSystemRepresentation returns a NUL-terminated path pointer valid for the
            // duration of this NSURL call. The bytes are copied into PathBuf before returning.
            let representation = unsafe { url.fileSystemRepresentation() };
            let path = unsafe { CStr::from_ptr(representation.as_ptr()) };
            dispatch(MacOSApplicationEvent::OpenFile(PathBuf::from(
                std::ffi::OsStr::from_bytes(path.to_bytes()),
            )));
            continue;
        }
        // SAFETY: AppKit supplied a live NSURL and the retained NSString is converted immediately.
        if let Some(serialized) = unsafe { url.absoluteString() } {
            dispatch(MacOSApplicationEvent::OpenUrl(serialized.to_string()));
        }
    }
}

extern "C" fn application_should_handle_reopen(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &NSApplication,
    has_visible_windows: Bool,
) -> Bool {
    dispatch(MacOSApplicationEvent::Activated(
        ApplicationActivation::new(has_visible_windows.as_bool()),
    ));
    // ZUI has accepted the reopen request, so AppKit must not create an untitled document.
    Bool::NO
}

fn dispatch(event: MacOSApplicationEvent) {
    EVENT_HANDLER.with(|handler| {
        if let Some(handler) = handler.borrow().as_ref() {
            handler(event);
        }
    });
}

unsafe fn add_method(
    class: &AnyClass,
    selector: Sel,
    implementation: Imp,
    return_encoding: &Encoding,
    argument_encodings: &[Encoding],
) {
    let mut types = format!(
        "{}{}{}",
        return_encoding,
        <*mut AnyObject as Encode>::ENCODING,
        Sel::ENCODING
    );
    for argument in argument_encodings {
        write!(&mut types, "{argument}").expect("Objective-C type encoding should be writable");
    }
    let types = CString::new(types).expect("Objective-C type encoding cannot contain NUL bytes");
    let class = (class as *const AnyClass)
        .cast_mut()
        .cast::<objc2::ffi::objc_class>();
    // SAFETY: the caller proves that the selector, function ABI, and generated encoding agree.
    let added = Bool::from_raw(unsafe {
        objc2::ffi::class_addMethod(
            class,
            selector.as_ptr(),
            Some(implementation),
            types.as_ptr(),
        )
    });
    assert!(
        added.as_bool(),
        "failed to add Objective-C method {selector}"
    );
}
