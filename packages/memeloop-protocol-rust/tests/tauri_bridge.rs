use memeloop_protocol::{
    OrchestrationCommandBackend, OrchestrationErrorData, RemoteOrchestrationOperation,
    RemoteOrchestrationRequest, RemoteOrchestrationResponse, TauriOrchestrationBridge,
    REMOTE_ORCHESTRATION_PROTOCOL,
};
use serde_json::{Map, json};

struct FakeBackend;

impl OrchestrationCommandBackend for FakeBackend {
    fn request(
        &self,
        request: RemoteOrchestrationRequest,
    ) -> Result<RemoteOrchestrationResponse, OrchestrationErrorData> {
        Ok(RemoteOrchestrationResponse {
            protocol: REMOTE_ORCHESTRATION_PROTOCOL.to_owned(),
            request_id: request.request_id,
            ok: true,
            result: Some(json!({ "operations": ["get", "watch"] })),
            error: None,
        })
    }

    fn watch(
        &self,
        request: RemoteOrchestrationRequest,
    ) -> Result<
        Box<dyn Iterator<Item = RemoteOrchestrationResponse> + Send>,
        OrchestrationErrorData,
    > {
        Ok(Box::new(
            vec![RemoteOrchestrationResponse {
                protocol: REMOTE_ORCHESTRATION_PROTOCOL.to_owned(),
                request_id: request.request_id,
                ok: true,
                result: Some(json!({
                    "type": "BOOKMARK",
                    "resourceVersion": "12"
                })),
                error: None,
            }]
            .into_iter(),
        ))
    }
}

fn request(
    request_id: &str,
    operation: RemoteOrchestrationOperation,
) -> RemoteOrchestrationRequest {
    RemoteOrchestrationRequest {
        protocol: REMOTE_ORCHESTRATION_PROTOCOL.to_owned(),
        request_id: request_id.to_owned(),
        operation,
        payload: Map::new(),
    }
}

#[test]
fn tauri_bridge_routes_requests_and_owns_watch_lifecycle() {
    let bridge = TauriOrchestrationBridge::new(FakeBackend);
    let response = bridge
        .request(request(
            "request-1",
            RemoteOrchestrationOperation::Capabilities,
        ))
        .unwrap();
    assert_eq!(response.request_id, "request-1");

    let opened = bridge
        .watch_open(request("watch-1", RemoteOrchestrationOperation::Watch))
        .unwrap();
    let event = bridge.watch_next(&opened.watch_id).unwrap();
    assert!(!event.done);
    assert_eq!(event.response.unwrap().request_id, "watch-1");
    assert!(bridge.watch_next(&opened.watch_id).unwrap().done);
    assert_eq!(
        bridge.watch_next(&opened.watch_id).unwrap_err().code,
        "NOT_FOUND"
    );

    let second = bridge
        .watch_open(request("watch-2", RemoteOrchestrationOperation::Watch))
        .unwrap();
    bridge.watch_close(&second.watch_id).unwrap();
    assert_eq!(
        bridge.watch_next(&second.watch_id).unwrap_err().code,
        "NOT_FOUND"
    );
}
