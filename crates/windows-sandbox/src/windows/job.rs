use super::win;
use super::win::Result;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::JobObjects::*;

pub(super) struct Job(win::Handle);

pub(super) fn name(account: &str) -> String {
    format!("Local\\AshSandbox.{account}")
}

impl Job {
    pub(super) fn new(account: &str) -> Result<Self> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), win::wide(name(account)).as_ptr()) };
        let error = unsafe { GetLastError() };
        let job = Self(win::Handle::new(raw, "CreateJobObjectW")?);
        if error == ERROR_ALREADY_EXISTS {
            return Err(
                "the execution job is still active; installation recovery is required".into(),
            );
        }
        let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(win::error("SetInformationJobObject"));
        }
        Ok(job)
    }
    pub(super) fn handle_value(&self) -> HANDLE {
        self.0.0
    }
    pub(super) fn assign_process(&self, process: HANDLE) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.0, process) } == 0 {
            return Err(win::error("AssignProcessToJobObject"));
        }
        Ok(())
    }
    pub(super) fn set_ui_limits(&self) -> Result<()> {
        let restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: 0xff,
        };
        if unsafe {
            SetInformationJobObject(
                self.0.0,
                JobObjectBasicUIRestrictions,
                (&restrictions as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
                size_of_val(&restrictions) as u32,
            )
        } == 0
        {
            return Err(win::error("SetInformationJobObject(UI)"));
        }
        Ok(())
    }
    pub(super) fn terminate_and_wait(&self, exit: u32) -> Result<()> {
        if unsafe { TerminateJobObject(self.0.0, exit) } == 0 {
            return Err(win::error("TerminateJobObject"));
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let mut info = unsafe { std::mem::zeroed::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() };
            if unsafe {
                QueryInformationJobObject(
                    self.0.0,
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(win::error("QueryInformationJobObject"));
            }
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= until {
                return Err(
                    "process tree did not terminate; its lease and ACL journal must be retained"
                        .into(),
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    pub(super) fn recover(account: &str) -> Result<()> {
        let raw = unsafe { OpenJobObjectW(0x0004 | 0x0008, 0, win::wide(name(account)).as_ptr()) };
        if raw.is_null() && unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        Self(win::Handle::new(raw, "OpenJobObjectW(recovery)")?).terminate_and_wait(1)
    }
}
