use std::io;
use std::time::Duration;

pub(super) fn acquire(reason: &str) -> io::Result<Box<dyn Send>> {
    let connection = zbus::blocking::connection::Builder::system()
        .and_then(|builder| builder.method_timeout(Duration::from_secs(2)).build())
        .map_err(io::Error::other)?;
    let reply = connection
        .call_method(
            Some("org.freedesktop.login1"),
            "/org/freedesktop/login1",
            Some("org.freedesktop.login1.Manager"),
            "Inhibit",
            &("idle", "Ash", reason, "block"),
        )
        .map_err(io::Error::other)?;
    // logind ties the inhibition to this descriptor, independently of the bus connection.
    let descriptor: zbus::zvariant::OwnedFd =
        reply.body().deserialize().map_err(io::Error::other)?;
    Ok(Box::new(descriptor))
}
