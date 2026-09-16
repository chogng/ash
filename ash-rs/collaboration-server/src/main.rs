use ash_collaboration_server::CollaborationServerOptions;
use ash_collaboration_server::run;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

fn main() {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("ash-collaboration-server: process hardening failed: {error}");
        std::process::exit(1);
    }
    if let Err(error) = run_from_environment() {
        eprintln!("ash-collaboration-server: {error}");
        std::process::exit(1);
    }
}

fn run_from_environment() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let [listen, database] = arguments.as_slice() else {
        return Err("usage: ash-collaboration-server <IP:PORT> <DATABASE_PATH>; requires ASH_COLLABORATION_BEARER_TOKEN and optionally ASH_COLLABORATION_ALLOWED_ORIGIN".into());
    };
    let address: SocketAddr = listen
        .parse()
        .map_err(|_| "Collaboration listener must be an IP:PORT pair")?;
    let token = env::var("ASH_COLLABORATION_BEARER_TOKEN")
        .map_err(|_| "ASH_COLLABORATION_BEARER_TOKEN is required")?;
    let mut options = CollaborationServerOptions::new(address, PathBuf::from(database), token);
    if let Ok(origins) = env::var("ASH_COLLABORATION_ALLOWED_ORIGIN") {
        for origin in origins.split(',').filter(|origin| !origin.is_empty()) {
            options = options.with_allowed_origin(origin);
        }
    }
    if let Ok(server_url) = env::var("ASH_LIVEKIT_SERVER_URL") {
        let api_url = env::var("ASH_LIVEKIT_API_URL")
            .map_err(|_| "ASH_LIVEKIT_API_URL is required with media")?;
        let api_key = env::var("ASH_LIVEKIT_API_KEY")
            .map_err(|_| "ASH_LIVEKIT_API_KEY is required with media")?;
        let secret = env::var("ASH_LIVEKIT_API_SECRET")
            .map_err(|_| "ASH_LIVEKIT_API_SECRET is required with media")?;
        let service = livekit_api::MediaService::new(
            &server_url,
            &api_url,
            api_key,
            ash_secrets::SecretValue::new(secret.into_bytes()),
        )?;
        options = options.with_media_service(service);
    }
    run(options)?;
    Ok(())
}
