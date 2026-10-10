fn main() {
    if external_ext_sdk::run_stdio(github_authentication::GitHubAuthenticationExtension::default())
        .is_err()
    {
        eprintln!("GitHub authentication extension stopped");
        std::process::exit(1);
    }
}
