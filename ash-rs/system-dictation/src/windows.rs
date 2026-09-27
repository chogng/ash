use crate::DictationError;
use crate::DictationEvent;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::thread::JoinHandle;
use windows::Win32::Media::Speech::ISpRecoResult;
use windows::Win32::Media::Speech::ISpRecognizer;
use windows::Win32::Media::Speech::SPEI_RECOGNITION;
use windows::Win32::Media::Speech::SPEVENT;
use windows::Win32::Media::Speech::SPLO_STATIC;
use windows::Win32::Media::Speech::SPRS_ACTIVE;
use windows::Win32::Media::Speech::SpSharedRecognizer;
use windows::Win32::System::Com::CLSCTX_ALL;
use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::System::Com::CoInitializeEx;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::CoUninitialize;
use windows::core::Interface;
use windows::core::PCWSTR;
use windows::core::PWSTR;

pub(super) fn start(
    stop: Arc<AtomicBool>,
    on_event: impl Fn(DictationEvent) + Send + 'static,
) -> Result<JoinHandle<()>, DictationError> {
    let (ready, initialized) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("system-dictation".into())
        .spawn(move || {
            // SAPI interfaces and their event results must stay on the COM apartment that created them.
            let apartment = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok();
            if let Err(error) = apartment {
                let _ = ready.send(Err(error.to_string()));
                return;
            }
            let mut started = false;
            let result = unsafe { recognize(&stop, &on_event, ready, &mut started) };
            if let Err(error) = result
                && started
            {
                on_event(DictationEvent::Failed(error.to_string()));
            }
            if started {
                on_event(DictationEvent::Ended);
            }
            unsafe { CoUninitialize() };
        })
        .map_err(|error| DictationError::System(error.to_string()))?;
    match initialized.recv() {
        Ok(Ok(())) => Ok(worker),
        Ok(Err(error)) => {
            let _ = worker.join();
            Err(DictationError::System(error))
        }
        Err(error) => {
            let _ = worker.join();
            Err(DictationError::System(error.to_string()))
        }
    }
}

unsafe fn recognize(
    stop: &AtomicBool,
    on_event: &impl Fn(DictationEvent),
    ready: mpsc::SyncSender<Result<(), String>>,
    started: &mut bool,
) -> windows::core::Result<()> {
    let setup = (|| -> windows::core::Result<_> {
        let recognizer: ISpRecognizer =
            unsafe { CoCreateInstance(&SpSharedRecognizer, None, CLSCTX_ALL) }?;
        let context = unsafe { recognizer.CreateRecoContext() }?;
        unsafe { context.SetNotifyWin32Event() }?;
        let recognition_mask = 1_u64 << SPEI_RECOGNITION.0;
        unsafe { context.SetInterest(recognition_mask, recognition_mask) }?;
        let grammar = unsafe { context.CreateGrammar(1) }?;
        unsafe { grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) }?;
        unsafe { grammar.SetDictationState(SPRS_ACTIVE) }?;
        Ok((recognizer, context, grammar))
    })();
    let (_recognizer, context, grammar) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return Err(error);
        }
    };
    let _ = ready.send(Ok(()));
    *started = true;
    while !stop.load(Ordering::Acquire) {
        unsafe { context.WaitForNotifyEvent(200) }?;
        loop {
            let mut event = SPEVENT::default();
            let mut fetched = 0;
            unsafe { context.GetEvents(1, &mut event, &mut fetched) }?;
            if fetched == 0 {
                break;
            }
            if event._bitfield & 0xffff != SPEI_RECOGNITION.0 {
                continue;
            }
            let result = unsafe { ISpRecoResult::from_raw(event.lParam.0 as *mut _) };
            let mut text = PWSTR::null();
            let recognized = unsafe { result.GetText(0, u32::MAX, true, &mut text, None) };
            if recognized.is_ok() && !text.is_null() {
                let value = unsafe { text.to_string() }?;
                if !value.trim().is_empty() {
                    on_event(DictationEvent::Transcript(value));
                }
            }
            unsafe { CoTaskMemFree(Some(text.0.cast())) };
        }
    }
    drop(grammar);
    Ok(())
}
