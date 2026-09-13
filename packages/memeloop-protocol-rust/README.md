# memeloop-protocol

Serde wire types and the stateful command bridge for a Tauri MemeLoop host.

The application supplies an authenticated `OrchestrationCommandBackend`, stores
`TauriOrchestrationBridge<Backend>` in Tauri state, and exposes four thin
commands:

- `orchestration_request`
- `orchestration_watch_open`
- `orchestration_watch_next`
- `orchestration_watch_close`

The bridge validates protocol envelopes, owns watch iterators, returns
structured errors, and releases watches on completion or explicit close. The
application remains responsible for binding the backend to the authenticated
actor; callers never provide an actor in the wire request.
