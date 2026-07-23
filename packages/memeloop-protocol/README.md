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
