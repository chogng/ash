use crate::DictationError;
use crate::DictationEvent;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::thread::JoinHandle;
use windows::Win32::Media::Speech::ISpMMSysAudio;
use windows::Win32::Media::Speech::ISpRecoResult;
use windows::Win32::Media::Speech::ISpRecognizer;
use windows::Win32::Media::Speech::SPEI_RECOGNITION;
use windows::Win32::Media::Speech::SPEI_RESERVED1;
use windows::Win32::Media::Speech::SPEI_RESERVED2;
use windows::Win32::Media::Speech::SPEVENT;
use windows::Win32::Media::Speech::SPLO_STATIC;
use windows::Win32::Media::Speech::SPRS_ACTIVE;
use windows::Win32::Media::Speech::SpInprocRecognizer;
use windows::Win32::Media::Speech::SpMMAudioIn;
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
) -> Result<(), String> {
    let setup = (|| -> Result<_, String> {
        let recognizer: ISpRecognizer =
            unsafe { CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL) }
                .map_err(|error| format!("create recognizer: {error}"))?;
        let audio: ISpMMSysAudio = unsafe { CoCreateInstance(&SpMMAudioIn, None, CLSCTX_ALL) }
            .map_err(|error| format!("open default microphone: {error}"))?;
        unsafe { recognizer.SetInput(&audio, true) }
            .map_err(|error| format!("connect microphone to recognizer: {error}"))?;
        let context = unsafe { recognizer.CreateRecoContext() }
            .map_err(|error| format!("create recognition context: {error}"))?;
        unsafe { context.SetNotifyWin32Event() }
            .map_err(|error| format!("register recognition event: {error}"))?;
        // SAPI's SPFEI macro includes both reserved flag bits in every event-interest mask.
        let recognition_mask = (1_u64 << SPEI_RECOGNITION.0)
            | (1_u64 << SPEI_RESERVED1.0)
            | (1_u64 << SPEI_RESERVED2.0);
        unsafe { context.SetInterest(recognition_mask, recognition_mask) }
            .map_err(|error| format!("register recognition interest: {error}"))?;
        let grammar = unsafe { context.CreateGrammar(1) }
            .map_err(|error| format!("create dictation grammar: {error}"))?;
        unsafe { grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) }
            .map_err(|error| format!("load dictation grammar: {error}"))?;
        unsafe { grammar.SetDictationState(SPRS_ACTIVE) }
            .map_err(|error| format!("activate dictation grammar: {error}"))?;
        Ok((recognizer, audio, context, grammar))
    })();
    let (_recognizer, _audio, context, grammar) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return Err(error);
        }
    };
    let _ = ready.send(Ok(()));
    *started = true;
    while !stop.load(Ordering::Acquire) {
        unsafe { context.WaitForNotifyEvent(200) }
            .map_err(|error| format!("wait for recognition: {error}"))?;
        loop {
            let mut event = SPEVENT::default();
            let mut fetched = 0;
            unsafe { context.GetEvents(1, &mut event, &mut fetched) }
                .map_err(|error| format!("read recognition event: {error}"))?;
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
                let value = unsafe { text.to_string() }
                    .map_err(|error| format!("decode recognized text: {error}"))?;
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
