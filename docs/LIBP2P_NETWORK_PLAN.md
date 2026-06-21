# MemeLoop libp2p 网络服务目标规格

本文定义 MemeLoop/TidGi 设备互联的目标实现。目标网络栈只有 libp2p；上层同步、远程 agent、文件/知识库 RPC 不感知局域网、公网、NAT、relay 或移动端网络差异，只面向可信设备对象发送消息。

## 目标

- TidGi Desktop、TidGi Mobile、memeloop-cli 都运行同一种 MemeLoop 设备网络服务。
- 设备使用 libp2p PeerId 作为网络身份，PeerId 私钥保存在本机安全存储中。
- 未登录云服务时，设备能在同一局域网内互相发现，像蓝牙或 LocalSend 一样显示附近设备，双方确认后建立本地信任关系。
- 登录云服务后，同一账号下的设备自动出现在设备列表中，自动互信，不需要再次确认。
- 跨网络设备通过 MemeLoop 私有 bootstrap、relay、hole punching、WebRTC/QUIC/TCP/WebSocket transport 建立 libp2p stream。
- 所有 MemeLoop 应用协议通过 libp2p stream 承载，不再暴露手工 WebSocket URL、FRP 地址或 remote TCP port。
- Cloud 只负责账号、设备目录、授权 grant、私有 relay 准入和在线元数据；Cloud 不成为业务消息明文中继。
- 上层只通过 `DeviceNetworkService` 联系设备，不直接操作地址、socket、multiaddr、relay、DHT 或 NAT 逻辑。

## 非目标

- 不实现系统 VPN。
- 不请求 Android VPN 权限。
- 不请求 iOS NetworkExtension Packet Tunnel 权限。
- 不让整个设备流量进入隧道。
- 不连接公共 IPFS bootstrap。
- 不使用公共 DHT 发现 MemeLoop 设备。
- 不提供手工输入远端 WebSocket 地址的入口。
- 不提供 FRP 路径。
- 不保留 nodeSecret 登录方式。
- 不实现旧 WebSocket peer transport 的替代分支。
- 之前没用的实现就删掉，不要做任何向前兼容。不要加 legacy，不要加 Deprecated.，不要做保留，不要做兼容层

## 必删实现

删除以下实现和对应测试、文档、配置、数据库字段、环境变量：

- Cloud FRP endpoint：`/api/frps/endpoint`。
- Cloud FRP remote port allocator。
- `nodes.frp_remote_port`、`frp_address`、`public_ip` 作为连接地址来源。
- `FRPS_REMOTE_PORT_START`、`FRPS_REMOTE_PORT_END`、`FRPS_PUBLIC_HOST`、`FRPS_BIND_PORT`。
- `ConnectivityManager` 中公网 IP 探测和 FRP tunnel API。
- WebSocket peer URL 连接入口：`addPeerByUrl(wsUrl)` 形态。
- 以 `ws://host:port/ws` 作为节点发现结果的旧 LAN auto-connect。
- memeloop 节点间 JSON-RPC 的 HTTP upgrade WebSocket transport。
- 自定义 Noise_XX 帧加密 transport。
- 旧 PIN handshake RPC。
- nodeSecret 注册和 `/api/nodes/token` 换取 node JWT 的方式。
- 旧节点 registry 中以 listen port、public IP、FRP 地址描述节点连通性的字段。

保留账号登录、支付、订阅、LLM proxy、IM relay、知识库业务逻辑，但它们不能依赖旧节点网络路径。

## 设备身份

### 本地设备身份

每个安装实例创建一个稳定的 libp2p Ed25519 私钥：

```ts
export interface LocalDeviceIdentity {
  peerId: string;
  publicKeyMultibase: string;
  privateKeyRef: string;
  createdAt: number;
  deviceName: string;
  platform: "desktop" | "mobile" | "cli";
}
```

规则：

- `peerId` 是设备网络身份。
- 私钥不上传 Cloud。
- TidGi Desktop 使用系统 keychain 或 Electron 安全存储。
- TidGi Mobile 使用平台安全存储；如果当前安全存储无法保存 libp2p 私钥，则新增 native secure storage bridge。
- memeloop-cli 使用本地配置目录中的加密 key store；没有系统 keychain 时要求文件权限为当前用户可读写。
- 删除旧 `nodeId + nodeSecret` 的身份模型。

### 账号绑定

登录 Cloud 后，设备向 Cloud 绑定 PeerId：

```ts
export interface DeviceAccountBindingRequest {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: "desktop" | "mobile" | "cli";
  cloudNonce: string;
  signature: string;
}
```

签名内容：

```text
memeloop-device-binding-v1\n
accountId=<cloud account id>\n
peerId=<libp2p peer id>\n
publicKey=<public key multibase>\n
nonce=<cloud nonce>
```

Cloud 验证：

- 当前用户已登录。
- nonce 未过期且未使用。
- signature 可由 `publicKeyMultibase` 验证。
- `peerId` 与 `publicKeyMultibase` 匹配。
- 同一账号可绑定多个设备。
- 同一个 `peerId` 不能绑定到多个账号。

Cloud 保存：

```ts
export interface CloudDeviceRecord {
  accountId: string;
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: "desktop" | "mobile" | "cli";
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
  relayReservations: string[];
  lastSeen: number;
  revokedAt?: number;
}
```

## 信任模型

### 本地局域网配对

未登录 Cloud 时使用本地配对建立信任。

发现方式：

- 桌面和 CLI 使用 libp2p mDNS 或本地发现 provider。
- 移动端使用可在 iOS/Android 真机运行的 LAN discovery provider。
- 发现 payload 只包含 PeerId、公钥、设备名、平台、局域网 multiaddr、能力摘要。

连接规则：

1. 设备 A 发现设备 B。
2. A 用户选择连接 B。
3. A 向 B 发起 `/memeloop/pairing/1.0.0` stream。
4. 双方显示同一个短确认码。
5. A、B 都确认后，各自写入本地 trust store。
6. 未确认时，业务协议 stream 全部拒绝。

本地 trust store：

```ts
export interface TrustedDeviceRecord {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: "desktop" | "mobile" | "cli";
  trustMode: "local-pairing" | "cloud-account";
  accountId?: string;
  createdAt: number;
  lastSeen?: number;
  revokedAt?: number;
}
```

本地配对后的设备可以互发 MemeLoop 消息；这不需要 Cloud 账号。

### 云端同账号自动信任

登录 Cloud 后，同一账号下的设备自动互信。

Cloud 下发设备目录和授权 grant：

```ts
export interface DeviceConnectionGrant {
  issuer: "memeloop-cloud";
  accountId: string;
  subjectPeerId: string;
  allowedPeerIds: string[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
}
```

规则：

- 设备只接受同一账号目录中的 peer。
- 入站 stream 必须携带有效 grant。
- grant 必须包含本机 PeerId 和对端 PeerId。
- grant 过期后必须重新从 Cloud 获取。
- 用户在 Cloud 撤销设备后，Cloud 不再签发 grant，其他设备也从目录中移除该设备。
- 同账号设备不显示本地确认流程。

### 入站授权

所有 MemeLoop 协议 handler 统一经过 `DeviceAuthorizer`：

```ts
export interface DeviceAuthorizer {
  canOpenProtocol(input: {
    remotePeerId: string;
    protocol: string;
    presentedGrant?: DeviceConnectionGrant;
  }): Promise<boolean>;
}
```

授权来源：

- 本地 trust store 中的 `local-pairing` 记录。
- Cloud 设备目录和有效 `DeviceConnectionGrant`。

拒绝规则：

- 未知 PeerId 拒绝。
- grant 签名错误拒绝。
- grant 不包含本机 PeerId 拒绝。
- grant 不包含对端 PeerId 拒绝。
- Cloud 已撤销设备拒绝。
- 本地 trust store 已撤销设备拒绝。

## libp2p 网络栈

每个设备运行一个 `MemeLoopLibp2pNode`：

```ts
export interface MemeLoopLibp2pNodeOptions {
  identity: LocalDeviceIdentity;
  cloud?: CloudDeviceDirectoryClient;
  localDiscovery: LocalDiscoveryProvider;
  authorizer: DeviceAuthorizer;
  protocols: MemeLoopProtocolHandler[];
}
```

组件：

- identify。
- ping。
- private bootstrap list from MemeLoop Cloud。
- private circuit relay v2。
- relay reservation with Cloud-issued admission token。
- connection gater。
- libp2p Noise 或 TLS secure channel。
- stream muxer。
- TCP transport where platform supports it。
- WebSocket transport where platform supports it。
- WebRTC transport for browser/RN-compatible NAT traversal。
- DCUtR/hole punching where supported by selected js-libp2p packages。

禁止：

- public IPFS bootstrap。
- public DHT。
- accepting MemeLoop protocol streams from unauthorised peers。
- exposing raw libp2p node object to app feature layers。

## 网络服务层接口

上层只依赖设备对象和消息接口。

```ts
export interface Device {
  peerId: string;
  displayName: string;
  platform: "desktop" | "mobile" | "cli";
  trustMode: "local-pairing" | "cloud-account";
  reachability: DeviceReachability;
  capabilities: DeviceCapabilities;
  lastSeen?: number;
}

export interface DeviceReachability {
  state: "nearby" | "online" | "offline" | "connecting";
  paths: Array<"lan" | "direct" | "relay">;
}

export interface DeviceNetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLocalDevice(): Promise<Device>;
  listDevices(): Promise<Device[]>;
  observeDevices(listener: (devices: Device[]) => void): () => void;
  requestLocalPairing(peerId: string): Promise<PairingSession>;
  acceptPairing(sessionId: string): Promise<void>;
  rejectPairing(sessionId: string): Promise<void>;
  removeTrustedDevice(peerId: string): Promise<void>;
  openStream(peerId: string, protocol: MemeLoopProtocol): Promise<MemeLoopDuplexStream>;
  sendRpc<T>(peerId: string, method: string, params: unknown): Promise<T>;
  syncWithDevice(peerId: string): Promise<SyncResult>;
}
```

`DeviceNetworkService` 是 Desktop、Mobile、CLI 的唯一网络入口。

### 协议

```ts
export type MemeLoopProtocol =
  | "/memeloop/rpc/1.0.0"
  | "/memeloop/sync/1.0.0"
  | "/memeloop/agent/1.0.0"
  | "/memeloop/pairing/1.0.0";
```

- `/memeloop/pairing/1.0.0` 只用于本地配对确认。
- `/memeloop/rpc/1.0.0` 承载通用 JSON-RPC。
- `/memeloop/sync/1.0.0` 承载 `ChatSyncEngine` 所需同步调用。
- `/memeloop/agent/1.0.0` 承载 remote agent 创建、消息、事件流。

## 对现有同步层的要求

`ChatSyncEngine` 不处理网络地址。

新增 `Libp2pDeviceSyncTransport` 实现现有 peer transport：

```ts
export interface DeviceSyncTransport {
  listPeers(): Promise<Device[]>;
  exchangeVersionVector(
    peerId: string,
    localVersion: VersionVector,
  ): Promise<ExchangeVersionVectorResult>;
  pullMissingMetadata(peerId: string, sinceVersion: VersionVector): Promise<ConversationMeta[]>;
  pullMissingMessages(
    peerId: string,
    conversationId: string,
    knownMessageIds: string[],
  ): Promise<ChatMessage[]>;
  pullAttachmentBlob(peerId: string, contentHash: string): Promise<AttachmentBlob | null>;
}
```

`remoteAgent`、文件工具代理、知识库代理都以 `peerId` 定位设备，不使用 URL。

## Cloud API

新增 Cloud 设备 API：

```http
POST /api/devices/binding/nonce
POST /api/devices/register
GET  /api/devices
POST /api/devices/:peerId/revoke
POST /api/devices/connection-grant
POST /api/devices/relay-reservation
POST /api/devices/heartbeat
```

行为：

- `GET /api/devices` 只返回当前账号下设备。
- `connection-grant` 只为当前账号下未撤销设备签发。
- `relay-reservation` 只为已登录且已绑定设备签发。
- heartbeat 更新 capabilities、multiaddrs、relay reservation、lastSeen。
- Cloud 不返回其他账号设备。
- Cloud 不接受客户端上报的 accountId 作为授权依据，accountId 必须来自登录 token。

## 私有 relay/bootstrap

MemeLoop Cloud 运行或管理私有 libp2p bootstrap/relay 节点。

要求：

- relay 只接受 Cloud 签发的 admission token。
- admission token 绑定 PeerId、accountId、过期时间。
- relay 不接受匿名 reservation。
- relay 不加入公共 IPFS 网络。
- relay multiaddr 由 Cloud 设备目录下发。
- relay 只作为 libp2p transport，不做 MemeLoop RPC 解析。

## Desktop 接入点

- 新增 Desktop `DeviceNetworkService` 主进程服务。
- 服务注册到现有 Inversify service container。
- Renderer 只能通过 IPC 调 `DeviceNetworkService`，不能直接访问 libp2p node。
- Agent、同步、设置页通过 `Device` 对象展示设备。
- 删除手工 peer URL 输入 UI。
- 删除 FRP 相关设置 UI。

## Mobile 接入点

- 新增 `src/services/deviceNetwork`。
- 引入 js-libp2p React Native 所需依赖和 polyfill。
- 使用 Expo dev-client/CNG，不支持 Expo Go。
- 使用 Metro alias 映射 Node core polyfill。
- 使用 native module 提供 RN 所需 crypto/random/tcp/local discovery 能力。
- 同步 UI 展示附近设备和云端同账号设备。
- 未登录时只显示附近可配对设备。
- 登录后显示同账号设备和附近设备。
- 同账号设备不要求确认；附近非账号设备要求双方确认。

## CLI 接入点

- `memeloop-cli start` 启动 libp2p node。
- CLI 输出本机 PeerId 和可发现状态。
- CLI 支持列出设备、发起本地配对、撤销本地信任。
- CLI remote agent 和 sync 命令以 PeerId 或设备名选择目标。

## 数据库模型

Cloud 新增表：

```sql
cloud_devices(
  peer_id text primary key,
  account_id uuid not null references users(id),
  public_key_multibase text not null,
  device_name text not null,
  platform text not null,
  capabilities jsonb not null,
  multiaddrs jsonb not null,
  relay_reservations jsonb not null,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
)
```

```sql
device_binding_nonces(
  nonce text primary key,
  account_id uuid not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz
)
```

删除旧节点连接字段和 FRP 字段。

## 测试要求

### 单元测试

- PeerId 与 public key 匹配验证。
- 设备绑定签名验证。
- nonce 一次性使用。
- 同账号 grant 签发。
- 跨账号 grant 拒绝。
- 已撤销设备 grant 拒绝。
- 本地 trust store 授权。
- 未知 peer 协议 stream 拒绝。
- grant 缺少本机 PeerId 拒绝。
- grant 缺少对端 PeerId 拒绝。

### 集成测试

- 两个未登录节点在同一局域网发现彼此。
- 未确认配对时无法打开 `/memeloop/sync/1.0.0`。
- 双方确认后能同步消息。
- 同账号两个设备登录后自动出现在设备列表。
- 同账号两个设备无需确认即可打开 sync stream。
- 不同账号设备不能通过 Cloud 设备目录互相发现。
- 不同账号设备即使知道 PeerId 也不能打开 MemeLoop 协议 stream。
- 两个 NAT 后设备通过私有 relay 打开 `/memeloop/rpc/1.0.0`。
- relay 不能读取 MemeLoop RPC payload。

### 移动端测试

- Android 真机启动 libp2p node。
- iOS 真机启动 libp2p node。
- Android 与 Desktop 局域网发现。
- iOS 与 Desktop 局域网发现。
- Android 与 Desktop 双方确认配对。
- iOS 与 Desktop 双方确认配对。
- 登录 Cloud 后 Android 自动列出同账号 Desktop。
- 登录 Cloud 后 iOS 自动列出同账号 Desktop。
- 断网重连后设备目录和 relay reservation 恢复。

## 实施进度

### Phase 1 — 统一设备对象模型与四端接入 ✅

- [x] 在 `memeloop` core 定义 `DeviceNetworkService` 共享契约、`MemoryDeviceNetworkService` 内存实现。
- [x] 从 `memeloop` 主入口导出 device-network 类型与实现。
- [x] Cloud 新增 `cloud_devices` / `device_binding_nonces` 表与 `/api/devices/*` 路由。
- [x] Cloud 移除 `/api/frps/endpoint` 及旧节点路由注册。
- [x] CLI 用 device identity + `DeviceCloudClient` 替换 `nodeSecret`/`nodeId` 配置与旧启动路径。
- [x] Desktop 新增 `DeviceNetworkService` 主进程服务并注册到容器/IPC/preload，在 `commonInit` 启动。
- [x] Mobile 新增 `DeviceNetworkService`（Expo SecureStore 加密身份）与 `useDeviceNetwork`，在 `App` 启动。

### Phase 2 — 清理旧网络实现 ✅

- [x] 删除 `memeloop` 旧网络模块：`connectivity`、`knownNodesStore`、`pinConfirmCode`、`pinPairing`、`authHandshake`、`noiseTransport`、`noiseXxHandshake` 及 CLI `network/` 旧代码。
- [x] 停止从 `memeloop` 主入口导出旧网络 API。
- [x] 删除 CLI 中手工 WebSocket peer URL、FRP、nodeSecret 相关 UI 与配置（ConfigTUI、nodeRuntime、auth/cloudClient）。
- [x] 确认 Desktop/Mobile 中无旧网络 UI 残留（如后续发现继续清理）。
- [x] 删除 Cloud FRP endpoint/runtime/deploy 入口：`packages/memeloop-cloud/src/frp/` 模块与测试、`deploy/frps/`、`docker-compose.yml` 中 `frps` 服务及相关环境变量、`.env.example` 中 `FRPS_*` 变量。
- [x] 删除 Cloud 旧节点 registry 模块：`packages/memeloop-cloud/src/registry/` 及测试（旧 `/api/nodes` 列表、心跳、远程 agent Cloud 代理）。
- [x] 删除 Cloud 旧 node auth 路由实现与专属测试：`packages/memeloop-cloud/src/auth/nodeAuth.ts`、`packages/memeloop-cloud/src/__tests__/nodeAuth.more.test.ts`。
- [x] 删除 Cloud admin/config 中 FRP 展示与 Nacos `frps` 配置残留。
- [x] 删除 Cloud admin ECS 旧 `nodeSecret` 一键部署入口：`packages/memeloop-cloud/src/admin/ecsDeployment.ts`、`/api/admin/nodes/deploy/ecs`、Admin 节点页部署表单。
- [x] 更新/删除 Cloud 旧节点运维文档中的 FRP 内容。
- [x] 迁移/删除 Cloud 数据库中旧 `nodes` / `node_otps` / `node_auth_challenges` 表与旧 `node_id` 外键（`im_channel_routes.*` 等已迁移到 `peer_id`，旧表在迁移 `018_drop_legacy_node_tables` 中删除）。

### Phase 3 — libp2p 真实节点与发现（进行中）

- [x] 实现 `MemeLoopLibp2pNode` 骨架：`Libp2pDeviceNetworkService` 使用 js-libp2p 3.x + Noise + Yamux + TCP/WebSocket + mDNS，支持 start/stop、设备发现、可信设备 stream 打开。
- [x] 统一设备身份：`createDeviceIdentity`、`signDeviceBinding`、`verifyDeviceBinding` 使用 `@libp2p/crypto` 生成真实 PeerId 与 raw seed，四端统一 `libp2p-pub:` publicKeyMultibase。
- [x] 修正 PeerId 派生与验签链：PeerId 从 libp2p private/public key 派生，Cloud 设备注册验证 `libp2p-pub:` 公钥、PeerId 匹配和 Ed25519 签名。
- [x] 引入本地 `DeviceAuthorizer` 示例实现，未知设备只能打开 pairing 协议，业务协议拒绝未知或已撤销 peer。
- [x] 将 `Libp2pDeviceNetworkService` 注入 CLI、Desktop、Mobile 默认替换 `MemoryDeviceNetworkService`。
- [x] `memeloop` core 包改为 ESM package（`"type": "module"`），解决 ESM-only libp2p 依赖的 CJS 声明冲突。
- [ ] 跨平台 transport/discovery 运行时注入（CLI Desktop 用 TCP/WS/mDNS；Mobile/RN 后续用自定义 transport）。
- [ ] 本地局域网配对流程（mDNS / RN discovery + 确认码 + 双向确认写入 trust store）。
- [ ] Cloud 设备目录同步、grant 拉取与入站 `DeviceAuthorizer` 校验。
- [ ] 私有 relay/bootstrap 与 admission token。

### Phase 4 — 同步与测试（待开始）

- [ ] 实现 `Libp2pDeviceSyncTransport` 接入 `ChatSyncEngine`。
- [ ] 单元测试：身份、签名、nonce、grant、trust store。
- [ ] 集成测试：局域网配对、同账号跨网络同步、跨账号拒绝、relay 打孔。
- [ ] 移动端真机测试。

## 完成定义

实现完成时满足：

- 代码中没有 FRP 节点连接路径。
- 代码中没有手工 WebSocket peer URL 连接路径。
- 代码中没有 nodeSecret 换 node JWT 的节点身份路径。
- 上层同步只依赖 `DeviceNetworkService`。
- 未登录同局域网设备可发现、可双方确认、可同步。
- 已登录同账号设备可跨网络发现、无需确认、可同步。
- 不同账号设备不能通过 Cloud 互相发现或通信。
- 私有 relay 只接受 Cloud 授权设备。
- TidGi-Mobile 不请求 VPN 权限。
- 桌面端不创建系统 VPN 或虚拟网卡。
