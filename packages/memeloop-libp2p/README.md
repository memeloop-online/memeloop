# @memeloop/libp2p

Optional concrete libp2p transport, identity, pairing, relay, and cloud-grant
adapter for MemeLoop hosts.

The portable `memeloop` package owns device-network protocols and interfaces
but deliberately installs no TCP, mDNS, WebSocket, relay, or libp2p runtime.
Hosts that need peer networking install this package explicitly.

Node and Electron hosts import `Libp2pDeviceNetworkService` from
`@memeloop/libp2p`. This default entry supports TCP, WebSocket, circuit-relay,
bootstrap, and mDNS discovery.

Browser and React Native hosts import the same class name from
`@memeloop/libp2p/browser`. The browser entry supports WebSocket bootstrap and
circuit relay, and deliberately excludes Node TCP and mDNS dependencies:

```ts
import { Libp2pDeviceNetworkService } from "@memeloop/libp2p/browser";
```

Both entries export `CloudDeviceAuthorizer` and the identity, signature,
connection-grant, and relay-token helpers.
