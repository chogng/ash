use std::cell::RefCell;
use windows::Win32::Foundation::HWND;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi as gdi;
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::Controls::{DRAWITEMSTRUCT, ODS_FOCUS, ODS_SELECTED};
use windows::Win32::UI::WindowsAndMessaging as win;
use windows::core::HSTRING;
use windows::core::w;

pub(crate) const FIRST_CONTROL: usize = 100;
pub(crate) const CONTROL_COUNT: usize = 7;

fn load_icon() -> win::HICON {
    let ico = include_bytes!("../../resources/win32/ash.ico");
    let size = u32::from_le_bytes(ico[14..18].try_into().unwrap()) as usize;
    let offset = u32::from_le_bytes(ico[18..22].try_into().unwrap()) as usize;
    let mut aligned = vec![0u32; size.div_ceil(4)];
    let image = unsafe { std::slice::from_raw_parts_mut(aligned.as_mut_ptr().cast::<u8>(), size) };
    image.copy_from_slice(&ico[offset..offset + size]);
    unsafe {
        win::CreateIconFromResourceEx(image, true, 0x30000, 0, 0, win::LR_DEFAULTCOLOR)
            .unwrap_or_default()
    }
}

pub(crate) struct NativeTitlebar {
    hwnd: HWND,
    icon: win::HICON,
    buttons: Vec<HWND>,
    labels: RefCell<Vec<String>>,
}

impl NativeTitlebar {
    pub(crate) fn open(hwnd: HWND) -> windows::core::Result<Self> {
        let mut bar = Self {
            hwnd,
            icon: load_icon(),
            buttons: Vec::new(),
            labels: RefCell::new(Vec::new()),
        };
        for index in 0..CONTROL_COUNT {
            let button = unsafe {
                win::CreateWindowExW(
                    win::WINDOW_EX_STYLE::default(),
                    w!("BUTTON"),
                    w!(""),
                    win::WS_CHILD
                        | win::WS_VISIBLE
                        | win::WS_TABSTOP
                        | win::WINDOW_STYLE(win::BS_OWNERDRAW as u32),
                    0,
                    0,
                    0,
                    0,
                    Some(hwnd),
                    Some(win::HMENU((FIRST_CONTROL + index) as *mut _)),
                    None,
                    None,
                )?
            };
            bar.buttons.push(button);
        }
        Ok(bar)
    }

    pub(crate) fn label(&self, message: &str) {
        let labels: Vec<_> = message.split('\n').collect();
        if labels.len() != self.buttons.len()
            || labels
                .iter()
                .any(|label| label.len() > 128 || label.contains('\0'))
        {
            return;
        }
        for (button, label) in self.buttons.iter().zip(&labels) {
            unsafe {
                let _ = win::SetWindowTextW(*button, &HSTRING::from(*label));
            }
        }
        *self.labels.borrow_mut() = labels.into_iter().map(str::to_owned).collect();
        for button in &self.buttons {
            unsafe {
                let _ = gdi::InvalidateRect(Some(*button), None, false);
            }
        }
    }

    pub(crate) fn draw(&self, item: &DRAWITEMSTRUCT) -> bool {
        let Some(index) = (item.CtlID as usize).checked_sub(FIRST_CONTROL) else {
            return false;
        };
        if self.buttons.get(index) != Some(&item.hwndItem) {
            return false;
        }
        let mut bounds = item.rcItem;
        let height = bounds.bottom - bounds.top;
        let selected = item.itemState.0 & ODS_SELECTED.0 != 0;
        unsafe {
            gdi::FillRect(item.hDC, &bounds, gdi::GetSysColorBrush(gdi::COLOR_WINDOW));
            if index == 1 || selected {
                let brush = gdi::GetSysColorBrush(gdi::COLOR_BTNFACE);
                gdi::InflateRect(&mut bounds, -2, -3).ok().ok();
                gdi::FillRect(item.hDC, &bounds, brush);
            }
            if index == 0 && !self.icon.is_invalid() {
                let size = height / 2;
                let _ = win::DrawIconEx(
                    item.hDC,
                    (bounds.left + bounds.right - size) / 2,
                    (bounds.top + bounds.bottom - size) / 2,
                    self.icon,
                    size,
                    size,
                    0,
                    None,
                    win::DI_NORMAL,
                );
            } else if matches!(index, 2 | 3 | 6) {
                let width = height / 2;
                let icon_height = width * 3 / 4;
                let left = (bounds.left + bounds.right - width) / 2;
                let top = (bounds.top + bounds.bottom - icon_height) / 2;
                let frame = windows::Win32::Foundation::RECT {
                    left,
                    top,
                    right: left + width,
                    bottom: top + icon_height,
                };
                let brush = gdi::GetSysColorBrush(gdi::COLOR_WINDOWTEXT);
                gdi::FrameRect(item.hDC, &frame, brush);
                let divider = match index {
                    2 => windows::Win32::Foundation::RECT {
                        top: frame.bottom - 4,
                        bottom: frame.bottom - 3,
                        ..frame
                    },
                    3 => windows::Win32::Foundation::RECT {
                        left: frame.right - 5,
                        right: frame.right - 4,
                        ..frame
                    },
                    _ => windows::Win32::Foundation::RECT {
                        left: frame.left + 4,
                        right: frame.left + 5,
                        ..frame
                    },
                };
                gdi::FillRect(item.hDC, &divider, brush);
            } else {
                let labels = self.labels.borrow();
                let (face, text) = if index == 1 {
                    (w!("Segoe UI"), labels.get(index).map_or("", String::as_str))
                } else {
                    (
                        w!("Segoe MDL2 Assets"),
                        [
                            "\u{e700}", "", "\u{e7c6}", "\u{e89f}", "\u{e72b}", "\u{e72a}",
                            "\u{e8a0}",
                        ][index],
                    )
                };
                let font = gdi::CreateFontW(
                    -(height * 42 / 100),
                    0,
                    0,
                    0,
                    400,
                    0,
                    0,
                    0,
                    gdi::DEFAULT_CHARSET,
                    gdi::OUT_DEFAULT_PRECIS,
                    gdi::CLIP_DEFAULT_PRECIS,
                    gdi::DEFAULT_QUALITY,
                    0,
                    face,
                );
                let previous = gdi::SelectObject(item.hDC, font.into());
                gdi::SetBkMode(item.hDC, gdi::TRANSPARENT);
                gdi::SetTextColor(
                    item.hDC,
                    windows::Win32::Foundation::COLORREF(gdi::GetSysColor(gdi::COLOR_WINDOWTEXT)),
                );
                let mut text: Vec<_> = text.encode_utf16().collect();
                if !text.is_empty() {
                    gdi::DrawTextW(
                        item.hDC,
                        &mut text,
                        &mut bounds,
                        gdi::DT_CENTER
                            | gdi::DT_VCENTER
                            | gdi::DT_SINGLELINE
                            | gdi::DT_END_ELLIPSIS
                            | gdi::DT_NOPREFIX,
                    );
                }
                gdi::SelectObject(item.hDC, previous);
                let _ = gdi::DeleteObject(font.into());
            }
            if item.itemState.0 & ODS_FOCUS.0 != 0 {
                let _ = gdi::DrawFocusRect(item.hDC, &bounds);
            }
        }
        true
    }

    pub(crate) fn layout(&self, width: i32, height: i32, inset: i32) -> windows::core::Result<()> {
        let unit = height.max(1);
        let button = unit * 4 / 5;
        let end = (width - inset - unit / 5).max(button * 5);
        let right = end - button * 2;
        let available = (right - button * 5).max(0);
        let search_width = (unit * 10).min(available);
        let search_left = (width / 2 - search_width / 2).clamp(button * 5, right);
        let search_width = search_width.min(right - search_left);
        for (control, (x, width)) in self.buttons.iter().zip([
            (0, button),
            (search_left, search_width),
            (right, button),
            (right + button, button),
            (search_left - button * 2, button),
            (search_left - button, button),
            (button, button),
        ]) {
            unsafe {
                win::SetWindowPos(
                    *control,
                    Some(win::HWND_TOP),
                    x,
                    2,
                    width,
                    (height - 4).max(1),
                    win::SWP_NOACTIVATE,
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn command(&self, id: usize) -> Option<usize> {
        if id != FIRST_CONTROL {
            return (FIRST_CONTROL + 1..FIRST_CONTROL + CONTROL_COUNT)
                .contains(&id)
                .then_some(id);
        }
        let labels = self.labels.borrow();
        if labels.len() != CONTROL_COUNT {
            return None;
        }
        unsafe {
            let menu = win::CreatePopupMenu().ok()?;
            for (index, label) in labels.iter().enumerate().skip(1) {
                let _ = win::AppendMenuW(
                    menu,
                    win::MF_STRING,
                    FIRST_CONTROL + index,
                    &HSTRING::from(label),
                );
            }
            drop(labels);
            let mut anchor = POINT::default();
            let mut bounds = windows::Win32::Foundation::RECT::default();
            let _ = win::GetClientRect(self.buttons[0], &mut bounds);
            anchor.y = bounds.bottom;
            let _ = ClientToScreen(self.buttons[0], &mut anchor);
            let result = win::TrackPopupMenu(
                menu,
                win::TPM_RETURNCMD | win::TPM_NONOTIFY,
                anchor.x,
                anchor.y,
                None,
                self.hwnd,
                None,
            );
            let _ = win::DestroyMenu(menu);
            (result.0 != 0).then_some(result.0 as usize)
        }
    }
}

impl NativeTitlebar {
    pub(crate) fn button_at(&self, point: POINT) -> Option<HWND> {
        self.buttons.iter().copied().find(|button| {
            let mut rect = windows::Win32::Foundation::RECT::default();
            (unsafe { win::GetWindowRect(*button, &mut rect).is_ok() })
                && (rect.left..rect.right).contains(&point.x)
                && (rect.top..rect.bottom).contains(&point.y)
        })
    }
}

impl Drop for NativeTitlebar {
    fn drop(&mut self) {
        unsafe {
            let _ = win::DestroyIcon(self.icon);
        }
        for button in &self.buttons {
            unsafe {
                let _ = win::DestroyWindow(*button);
            }
        }
    }
}
