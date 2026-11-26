# @memeloop/protocol

Portable ResourceClient protocol for browser, React Native, Electron renderer,
and Tauri WebView hosts. It contains no Node transport or controller.

`createFetchOrchestrationTransport` consumes the versioned JSON/NDJSON endpoint
mounted by the trusted Node/Electron-main
`createRemoteOrchestrationHttpHandler`. Authentication headers are supplied by
the host; callers never choose a ControlStore actor.

`PortableResourceCache` is the boundary for independently packaged IndexedDB or
native caches. A cache is advisory only: authoritative writes and watches still
go through the remote client.

`createIndexedDatabaseResourceCache` is the browser implementation. It stores
isolated remote snapshots and supports resource kind, namespace, API version,
and label queries without accepting authoritative writes.

For Tauri, pass `invoke` from `@tauri-apps/api/core` to
`createTauriOrchestrationClient`. The Rust `memeloop-protocol` crate provides
`TauriOrchestrationBridge`; an application exposes its `request`, `watch_open`,
`watch_next`, and `watch_close` methods through the four command names exported
by that crate. Authentication and the policy-scoped backend stay owned by the
Tauri application.
