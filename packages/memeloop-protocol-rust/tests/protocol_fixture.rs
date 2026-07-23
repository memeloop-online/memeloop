use memeloop_protocol::{
    REMOTE_ORCHESTRATION_PROTOCOL, RemoteOrchestrationRequest, RemoteOrchestrationResponse,
};
use serde_json::Value;

#[test]
fn typescript_wire_fixture_round_trips_without_shape_drift() {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/protocol-v1.json")).unwrap();
    let request: RemoteOrchestrationRequest =
        serde_json::from_value(fixture["request"].clone()).unwrap();
    request.validate().unwrap();
    assert_eq!(request.protocol, REMOTE_ORCHESTRATION_PROTOCOL);
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        fixture["request"].clone()
    );

    for key in ["success", "failure", "watch"] {
        let response: RemoteOrchestrationResponse =
            serde_json::from_value(fixture[key].clone()).unwrap();
        response.validate().unwrap();
        assert_eq!(serde_json::to_value(&response).unwrap(), fixture[key]);
    }
}
