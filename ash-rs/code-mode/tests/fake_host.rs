use ash_code_mode_protocol::{
    CODE_MODE_PROTOCOL_VERSION, CellId, ClientToHost, HostToClient, StartedCell, read_frame,
    write_frame,
};
use std::io::{self, BufReader, BufWriter, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut reader = BufReader::new(io::stdin().lock());
    let mut writer = BufWriter::new(io::stdout().lock());
    let executable = std::env::current_exe()?;
    let mode = executable.file_stem().and_then(|name| name.to_str());
    if matches!(mode, Some("silent-host" | "partial-host")) {
        std::fs::write(
            executable.with_extension("pid"),
            std::process::id().to_string(),
        )?;
        let _ = read_frame::<_, ClientToHost>(&mut reader)?;
        if mode == Some("partial-host") {
            writer.write_all(&100_u32.to_le_bytes())?;
            writer.write_all(b"{")?;
            writer.flush()?;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
        return Ok(());
    }

    loop {
        match read_frame::<_, ClientToHost>(&mut reader)? {
            ClientToHost::Hello { protocol_version }
                if protocol_version == CODE_MODE_PROTOCOL_VERSION =>
            {
                write_frame(
                    &mut writer,
                    &HostToClient::Hello {
                        protocol_version,
                        max_frame_bytes: ash_code_mode_protocol::MAX_FRAME_BYTES,
                    },
                )?;
            }
            ClientToHost::OpenSession { session_id, .. } => {
                write_frame(&mut writer, &HostToClient::SessionOpened { session_id })?;
            }
            ClientToHost::Execute(_) => {
                write_frame(
                    &mut writer,
                    &HostToClient::StartedCell(StartedCell {
                        cell_id: CellId::new("fake-cell-1")?,
                    }),
                )?;
            }
            ClientToHost::Wait(_) | ClientToHost::Terminate { .. } => {
                std::process::exit(17);
            }
            ClientToHost::CloseSession { .. } => return Ok(()),
            ClientToHost::CompleteToolCall { .. } | ClientToHost::Hello { .. } => {}
        }
    }
}
