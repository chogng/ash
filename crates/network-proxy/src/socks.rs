use crate::NetworkProtocol;
use crate::NetworkRequest;
use crate::server::Context;
use crate::server::HANDSHAKE_TIMEOUT;
use std::io;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;

pub(crate) async fn serve(mut stream: TcpStream, context: Arc<Context>) -> io::Result<()> {
    let request = timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream)).await??;
    let upstream = match context.connect(request).await {
        Ok(upstream) => upstream,
        Err(error) => {
            let code = if error.kind() == io::ErrorKind::PermissionDenied {
                2
            } else {
                4
            };
            stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(error);
        }
    };
    stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    crate::server::tunnel(stream, upstream, context).await;
    Ok(())
}

async fn handshake(stream: &mut TcpStream) -> io::Result<NetworkRequest> {
    let mut greeting = [0; 2];
    stream.read_exact(&mut greeting).await?;
    if greeting[0] != 5 {
        return Err(invalid());
    }
    let mut methods = vec![0; greeting[1] as usize];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 0xff]).await?;
        return Err(invalid());
    }
    stream.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 5 || header[1] != 1 || header[2] != 0 {
        stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(invalid());
    }
    let host = match header[3] {
        1 => {
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).await?;
            Ipv4Addr::from(bytes).to_string()
        }
        3 => {
            let length = stream.read_u8().await?;
            let mut bytes = vec![0; length as usize];
            stream.read_exact(&mut bytes).await?;
            String::from_utf8(bytes).map_err(|_| invalid())?
        }
        4 => {
            let mut bytes = [0; 16];
            stream.read_exact(&mut bytes).await?;
            format!("[{}]", Ipv6Addr::from(bytes))
        }
        _ => return Err(invalid()),
    };
    NetworkRequest::new(NetworkProtocol::Socks5Tcp, &host, stream.read_u16().await?)
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "unsupported SOCKS5 request")
}
