use ::client::ClientError;
use ::client::ClientRequest;
use ::client::ClientResponse;
use ::client::OperationClient;
use ::client::ResolvedApiTarget;
use http_client::HttpHeader;
use std::sync::Mutex;

pub(crate) struct Client {
    pub(crate) response: Result<ClientResponse, ClientError>,
    pub(crate) requests: Mutex<Vec<ClientRequest>>,
}

impl Client {
    pub(crate) fn response(status: u16, body: &str) -> Self {
        Self {
            response: Ok(ClientResponse::new(
                status,
                Vec::new(),
                body.as_bytes().to_vec(),
            )),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for Client {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.response.clone()
    }
}

pub(crate) fn target(base: &str) -> ResolvedApiTarget {
    ResolvedApiTarget::new(
        base,
        vec![
            HttpHeader::new("Authorization", "Bearer secret"),
            HttpHeader::new("ChatGPT-Account-ID", "account-1"),
            HttpHeader::new("User-Agent", "Ash/test"),
            HttpHeader::new("X-OpenAI-Fedramp", "true"),
        ],
    )
}
