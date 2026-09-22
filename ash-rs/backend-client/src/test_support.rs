use ::client::ClientError;
use ::client::ClientRequest;
use ::client::ClientResponse;
use ::client::OperationClient;
use std::sync::Mutex;

pub(crate) struct Transport {
    pub(crate) response: Result<ClientResponse, ClientError>,
    pub(crate) requests: Mutex<Vec<ClientRequest>>,
}

impl Transport {
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

impl OperationClient for Transport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.response.clone()
    }
}
