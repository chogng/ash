#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    app_server_test_client::run().await
}
