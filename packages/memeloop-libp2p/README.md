# @memeloop/libp2p

Optional concrete libp2p transport, identity, pairing, relay, and cloud-grant
adapter for MemeLoop hosts.

The portable `memeloop` package owns device-network protocols and interfaces
but deliberately installs no TCP, mDNS, WebSocket, relay, or libp2p runtime.
Node/Electron and React Native hosts that need peer networking install this
package explicitly and import `Libp2pDeviceNetworkService`,
`CloudDeviceAuthorizer`, or the identity/signature helpers from here.
