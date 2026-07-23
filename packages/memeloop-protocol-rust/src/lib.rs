use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const REMOTE_ORCHESTRATION_PROTOCOL: &str = "memeloop.resource.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOrchestrationOperation {
    Capabilities,
    Apply,
    Get,
    List,
    Watch,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOrchestrationRequest {
    pub protocol: String,
    pub request_id: String,
    pub operation: RemoteOrchestrationOperation,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationErrorData {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOrchestrationResponse {
    pub protocol: String,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<OrchestrationErrorData>,
}

impl RemoteOrchestrationRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol != REMOTE_ORCHESTRATION_PROTOCOL {
            return Err("unsupported protocol");
        }
        if self.request_id.is_empty() {
            return Err("requestId is empty");
        }
        Ok(())
    }
}

impl RemoteOrchestrationResponse {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol != REMOTE_ORCHESTRATION_PROTOCOL {
            return Err("unsupported protocol");
        }
        if self.request_id.is_empty() {
            return Err("requestId is empty");
        }
        if self.ok != self.result.is_some() || self.ok == self.error.is_some() {
            return Err("response must contain exactly one of result or error");
        }
        Ok(())
    }
}
