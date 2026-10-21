use std::io;
use std::time::Duration;

pub(super) fn acquire(reason: &str) -> io::Result<Box<dyn Send>> {
    // zbus 6 drives its async API through block_on for callers without a runtime.
    // Keep the connection and request in one scope; only the inhibitor FD escapes it.
    zbus::block_on(async {
        let connection = zbus::connection::Builder::system()
            .method_timeout(Duration::from_secs(2))
            .build()
            .await
            .map_err(io::Error::other)?;
        let reply = connection
            .call_method(
                Some("org.freedesktop.login1"),
                "/org/freedesktop/login1",
                Some("org.freedesktop.login1.Manager"),
                "Inhibit",
                &("idle", "Ash", reason, "block"),
            )
            .await
            .map_err(io::Error::other)?;
        // logind ties the inhibition to this descriptor, independently of the bus connection.
        let descriptor: zbus::wire::OwnedFd =
            reply.body().deserialize().map_err(io::Error::other)?;
        Ok(Box::new(descriptor) as Box<dyn Send>)
    })
}
