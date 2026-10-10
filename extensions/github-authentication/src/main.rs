fn main() {
    if extensions::run_stdio(github_authentication::GitHubAuthenticationExtension::default())
        .is_err()
    {
        eprintln!("GitHub authentication extension stopped");
        std::process::exit(1);
    }
}
