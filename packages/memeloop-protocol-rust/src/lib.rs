use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const REMOTE_ORCHESTRATION_PROTOCOL: &str = "memeloop.resource.v2";

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

pub const TAURI_REQUEST_COMMAND: &str = "orchestration_request";
pub const TAURI_WATCH_OPEN_COMMAND: &str = "orchestration_watch_open";
pub const TAURI_WATCH_NEXT_COMMAND: &str = "orchestration_watch_next";
pub const TAURI_WATCH_CLOSE_COMMAND: &str = "orchestration_watch_close";

pub trait OrchestrationCommandBackend: Send + Sync + 'static {
    fn request(
        &self,
        request: RemoteOrchestrationRequest,
    ) -> Result<RemoteOrchestrationResponse, OrchestrationErrorData>;

    fn watch(
        &self,
        request: RemoteOrchestrationRequest,
    ) -> Result<
        Box<dyn Iterator<Item = RemoteOrchestrationResponse> + Send>,
        OrchestrationErrorData,
    >;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriWatchOpenResult {
    pub watch_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriWatchNextResult {
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<RemoteOrchestrationResponse>,
}

type WatchIterator = Box<dyn Iterator<Item = RemoteOrchestrationResponse> + Send>;

/// Framework-independent state behind four thin `#[tauri::command]` wrappers.
/// The consuming Tauri app owns authentication and the policy-scoped backend.
pub struct TauriOrchestrationBridge<B: OrchestrationCommandBackend> {
    backend: B,
    watches: Mutex<HashMap<String, WatchIterator>>,
    watch_sequence: AtomicU64,
}

impl<B: OrchestrationCommandBackend> TauriOrchestrationBridge<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            watches: Mutex::new(HashMap::new()),
            watch_sequence: AtomicU64::new(0),
        }
    }

    pub fn request(
        &self,
        request: RemoteOrchestrationRequest,
    ) -> Result<RemoteOrchestrationResponse, OrchestrationErrorData> {
        validate_request(&request)?;
        if request.operation == RemoteOrchestrationOperation::Watch {
            return Err(protocol_error(
                "INVALID",
                "watch requests require orchestration_watch_open",
            ));
        }
        self.backend.request(request)
    }

    pub fn watch_open(
        &self,
        request: RemoteOrchestrationRequest,
    ) -> Result<TauriWatchOpenResult, OrchestrationErrorData> {
        validate_request(&request)?;
        if request.operation != RemoteOrchestrationOperation::Watch {
            return Err(protocol_error(
                "INVALID",
                "watch bridge accepts only watch operations",
            ));
        }
        let iterator = self.backend.watch(request)?;
        let watch_id = format!(
            "watch-{}",
            self.watch_sequence.fetch_add(1, Ordering::Relaxed) + 1
        );
        self.watches
            .lock()
            .map_err(|_| protocol_error("INTERNAL", "watch registry lock was poisoned"))?
            .insert(watch_id.clone(), iterator);
        Ok(TauriWatchOpenResult { watch_id })
    }

    pub fn watch_next(
        &self,
        watch_id: &str,
    ) -> Result<TauriWatchNextResult, OrchestrationErrorData> {
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| protocol_error("INTERNAL", "watch registry lock was poisoned"))?;
        let response = watches
            .get_mut(watch_id)
            .ok_or_else(|| protocol_error("NOT_FOUND", "watch does not exist"))?
            .next();
        if response.is_none() {
            watches.remove(watch_id);
        }
        Ok(TauriWatchNextResult {
            done: response.is_none(),
            response,
        })
    }

    pub fn watch_close(&self, watch_id: &str) -> Result<(), OrchestrationErrorData> {
        self.watches
            .lock()
            .map_err(|_| protocol_error("INTERNAL", "watch registry lock was poisoned"))?
            .remove(watch_id);
        Ok(())
    }
}

fn validate_request(request: &RemoteOrchestrationRequest) -> Result<(), OrchestrationErrorData> {
    request
        .validate()
        .map_err(|message| protocol_error("INVALID", message))
}

fn protocol_error(code: &str, message: &str) -> OrchestrationErrorData {
    OrchestrationErrorData {
        code: code.to_owned(),
        message: message.to_owned(),
        retryable: false,
        retry_after_ms: None,
        reason: None,
        details: None,
    }
}
