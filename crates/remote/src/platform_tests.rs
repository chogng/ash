use super::RemoteArchitecture;
use super::RemoteLinuxLibc;
use super::RemotePlatform;

#[test]
fn supported_remote_platforms_map_to_canonical_package_targets() {
    let targets = [
        (
            RemotePlatform::linux(RemoteArchitecture::Aarch64, RemoteLinuxLibc::Gnu),
            "aarch64-unknown-linux-gnu",
        ),
        (
            RemotePlatform::linux(RemoteArchitecture::Aarch64, RemoteLinuxLibc::Musl),
            "aarch64-unknown-linux-musl",
        ),
        (
            RemotePlatform::linux(RemoteArchitecture::X86_64, RemoteLinuxLibc::Gnu),
            "x86_64-unknown-linux-gnu",
        ),
        (
            RemotePlatform::linux(RemoteArchitecture::X86_64, RemoteLinuxLibc::Musl),
            "x86_64-unknown-linux-musl",
        ),
        (
            RemotePlatform::mac_os(RemoteArchitecture::Aarch64),
            "aarch64-apple-darwin",
        ),
        (
            RemotePlatform::mac_os(RemoteArchitecture::X86_64),
            "x86_64-apple-darwin",
        ),
    ];

    for (platform, target) in targets {
        assert_eq!(platform.target_triple(), target);
        assert_eq!(platform.to_string(), target);
        assert_eq!(RemotePlatform::from_target_triple(target), Some(platform));
    }
    assert_eq!(
        RemotePlatform::from_target_triple("x86_64-pc-windows-msvc"),
        None
    );
}
