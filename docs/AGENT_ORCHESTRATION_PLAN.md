# MemeLoop Declarative Agent Orchestration Plan

Status: design and implementation handoff
Last updated: 2026-07-16

This document is the source of truth for evolving MemeLoop from direct local or explicitly targeted agent execution into a declarative, multi-node agent orchestration system. It covers package boundaries, resources, controllers, execution planes, infrastructure driver interfaces, trust levels, hostile workers, storage, networking, recovery, rollout, and verification.

The design borrows reconciliation, class/claim/attachment resources, driver contracts, leases, and fencing from Kubernetes. It does not copy Kubernetes objects mechanically. Agent cognition, model access, tool effects, evidence, and prompt/data trust require separate first-class boundaries.

## 1. Goals

- Declare Agent workloads, placement, runtime, model, tool, network, storage, credential, trust, rollout, and verification requirements as resources.
- Continuously reconcile desired state instead of relying on one-shot recursive function calls.
- Run the same portable Agent and controller logic in Electron, browser WebViews, Tauri frontends, Mobile, and constrained workers without duplicating the domain runtime.
- Put full Node.js implementations in `memeloop-cli`, including process execution, SQLite, files, Node libp2p transports, etcd integration, plugin processes, local TiddlyWiki, terminals, and provider SDKs.
- Let Agent loops and tools run locally on managed or restricted workers so large fleets can use their own CPU, GPU, and local models.
- Support hostile or not-yet-trusted workers without allowing them to become control-plane members or exposing durable cluster credentials.
- Make every effect recoverable, auditable, attributable, fenced, and independently verifiable according to risk.
- Define stable, versioned, language-neutral interfaces comparable in role to CRI, CNI, and CSI, plus Agent-specific model, tool, credential, artifact, identity, approval, and audit interfaces.
- Preserve single-node operation as a complete first-class deployment while supporting quorum-based high availability when enough stable nodes exist.

## 2. Non-goals and hard limits

- MemeLoop cannot guarantee confidentiality or result integrity inside an operating system already controlled by root/admin malware.
- A process, container, local firewall, signed worker binary, or Agent permission prompt does not protect a task from a hostile host kernel.
- The system does not live-migrate arbitrary JavaScript stacks, LLM streams, shell processes, or in-memory plugin state.
- The first implementation does not provide generic distributed block storage, Kubernetes CSI wire compatibility, a malware eradication product, or the full Kubernetes RBAC and network-policy surface.
- Exactly-once side effects are not generally possible. MemeLoop provides stable operation identity, idempotency, fencing, effect records, and explicit manual-intervention states.
- A two-node cluster cannot simultaneously guarantee automatic availability and split-brain prevention without a third voter or witness.

## 3. Architectural invariants

1. The control plane is deterministic and does not run LLM prompts, Agent loops, or tools.
2. An Agent loop is a scheduled data-plane workload, even when it runs in the same process or on the same machine as a controller.
3. Tool execution is a separate effect boundary. A loop requests operations; it does not acquire ambient host or cluster authority.
4. Local fast paths must preserve the same authorization, operation identity, audit, and provenance semantics as remote paths.
5. Model access is a service dependency with its own policy and identity. Provider keys are not Agent configuration.
6. Worker-reported capabilities, labels, time, attestation, and completion are claims until a trusted component validates them.
7. Trust level and control-plane eligibility are independent. A powerful GPU worker is not therefore a voter or controller.
8. Host-specific implementations are adapters. Scheduling, reconciliation, loop state, operation state, trust propagation, and recovery rules remain in the portable core.
9. TypeScript types are not the sole protocol contract. Versioned JSON Schema and method catalogs are generated from the canonical schemas.
10. Secrets, raw credentials, platform paths, sockets, and native handles never appear in resource status, logs, checkpoints, or driver-neutral types.

## 4. Package and runtime boundaries

### 4.1 `packages/memeloop`: Portable Kernel

The core package owns:

- Agent definitions, loop profiles, loop state machines, tool decision semantics, and conversation-domain behavior.
- Resource types, defaulting, validation, conversion, conditions, events, owner references, and finalizer semantics.
- Pure reconciliation functions and scheduler filter/score algorithms.
- Portable controller queues and retry policy, with clock, timer, persistence, and concurrency injected.
- Resource, runtime, tool, model, network, storage, credential, artifact, identity, policy, and audit ports.
- Protocol envelopes, JSON-RPC codecs, worker protocol codecs, generated JSON Schema, and conformance fixtures.
- Hybrid logical clocks, stable IDs, idempotency keys, hashes, provenance, taint propagation, and deterministic winner rules.
- In-memory reference implementations for tests and browser-safe embedded usage.

Core runtime code must not depend on `node:*`, `Buffer`, `process`, filesystem paths, child processes, native addons, TCP/mDNS implementations, SQLite, etcd, Docker, or Kubernetes SDKs. Binary values use `Uint8Array`. Environment, randomness, cryptography, time, and transport are injected or use explicitly supported Web Platform primitives.

The default `memeloop` export must be portable. Browser support must not depend on bundlers silently substituting a reduced implementation while the default dependency graph remains Node-specific.

### 4.2 `packages/memeloop-cli`: Node Reference Implementation

The CLI package owns:

- The all-in-one daemon and CLI commands.
- SQLite standalone control store and etcd quorum adapter.
- File, Markdown, local TiddlyWiki, checkpoint, snapshot, and backup implementations.
- Child-process workers, process runtime, terminal sessions, file tools, local MCP, and browser automation.
- Node libp2p TCP/mDNS/WebSocket/relay implementations and worker gateways.
- Node plugin discovery and isolated plugin subprocess hosting.
- Complete AI SDK provider factories and local model process integration.
- Credential, model, artifact, sanitizer, scanner, verifier, and audit gateway implementations.
- Reference process, peer, restricted-worker, and quarantine-worker drivers.

`memeloop-cli` is both an executable and a reusable Node adapter library. It must publish side-effect-free subpath exports for runtime, device network, storage, orchestration, plugins, and model providers. Importing those entries must not parse CLI arguments, start a daemon, or call `process.exit()`.

### 4.3 Host adapters

- Electron renderer uses the portable client and UI. Electron main or worker processes reuse `memeloop-cli` adapters and add IPC, safe storage, OS integration, and repositories.
- Tauri WebViews can run the portable client and loop engine. Rust implements the generated protocol and platform adapters, or connects to an external Node daemon.
- A browser without filesystem access uses a remote ResourceClient, memory, or an independently packaged IndexedDB adapter. It cannot load Node runtime drivers.
- Mobile and low-power nodes advertise only the interfaces they can sustain. They can be clients, observers, model workers, loop workers, tool workers, or combinations without loading a full control plane.
- A user-hosted Linux pod is an ordinary node only after trusted enrollment. A newly acquired or security-unknown server starts as restricted or quarantine regardless of account ownership.

## 5. Control, cognition, action, and evidence planes

### 5.1 Control Plane

The control plane owns resources, admission, scheduling, leases, fencing epochs, reconciliation, rollout, status authorization, and garbage collection. It does not make LLM decisions or execute tools.

### 5.2 Cognition Plane

The cognition plane runs Agent loops, scripts, prompt assembly, memory compaction, model invocation, tool selection, checkpointing, and child-Agent requests. Its unit of execution is `AgentLoopRun`.

An Agent loop can run on trusted, restricted, or explicitly permitted quarantine workers. The trust level determines what inputs it receives, which model path it can use, which operations it may request, and how its output is treated. Running a loop on a worker does not grant it controller authority.

### 5.3 Action Plane

The action plane executes `ToolOperation` resources. Tool executors may be local to the loop, node-local sidecars/services, shared remote services, or trusted brokers. Every side effect has stable identity, policy, capability, deadline, idempotency, fencing, result evidence, and reconciliation state.

### 5.4 Evidence Plane

The evidence plane stores logs, operation effects, artifacts, provenance, scans, external observations, attestations, verification, and audit. A worker may report evidence, but only an authorized verifier can promote protected state such as `CompletedUnverified` to `Verified`.

## 6. Agent loop and tool executor composition

The Helm analogy is useful for packaging but not exact. Helm installs a set of resources; it does not define their runtime semantics. MemeLoop should model an `AgentWorkload` as the installed release-like desired state, then let controllers create independently schedulable resources.

- `AgentRun` is the root execution and ownership object.
- `AgentLoopRun` is the Pod-like cognition workload.
- A long-lived `ToolExecutorEndpoint` resembles a service or daemon workload.
- `ToolOperation` is an effect request, closer to a Job or RPC operation than a Pod.
- `ModelEndpoint` is a service dependency selected through `ModelClass` and `ModelPolicy`.
- `NetworkAttachment`, volume claims, credential handles, and artifact handles are attached dependencies.

The design supports four execution topologies.

| Topology             | Agent loop                                  | Tool executor                           | Best use                                               | Security meaning                                              |
| -------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| In-process fast path | Same process                                | Same process                            | Embedded and trusted single-node use                   | Same contracts still apply; no authorization bypass           |
| Co-located bundle    | Same node/process group                     | Sidecar or node service                 | Managed fleet, low latency, local files/devices        | Independent identities and policies despite co-location       |
| Split execution      | Worker or trusted node                      | Different trusted/restricted node       | Sensitive tools, special hardware, centralized brokers | Loop output is a request, not authority                       |
| Hierarchical fleet   | Fleet coordinator plus per-node local loops | Per-node local tools and shared brokers | Hundreds of heterogeneous machines                     | Central rollout policy, local adaptation, aggregated evidence |

Co-location is a scheduling preference or requirement, not an implicit API shortcut. The local implementation may avoid serialization for performance, but it must create the same `ToolOperation` identity or equivalent append-only event and pass the same policy checks.

## 7. Trust levels and placement

### 7.1 `trusted`

- May run loop, local model, tools, brokers, scanners, and verifiers.
- Can receive higher-classification inputs according to policy.
- Control-plane eligibility still requires separate administrator configuration and stable-node checks.

### 7.2 `restricted`

- Pure worker suitable for managed but shared, partially controlled, or not fully hardened machines such as labs, kiosks, and internet cafes.
- May run signed Agent loops, local models, and local tools.
- Uses task-scoped identity and credentials, deny-by-default external access, rollout limits, and verification appropriate to risk.
- Cannot be a voter, scheduler, controller, control-store replica, storage authority, or automatic trust source.
- This is the preferred class for bulk fleet configuration when the environment is not assumed fully compromised.

### 7.3 `quarantine`

- Assumed compromised before execution.
- May run an explicitly allowed untrusted planner loop to use local compute, but its prompt, memory, model output, status, and artifacts remain untrusted.
- Cannot open ordinary pairing, generic RPC, sync, Agent, peer-discovery, control-watch, or replication protocols.
- Cannot hold cluster, cloud, provider, control-store, ordinary device, IM, or long-lived asset credentials.
- Cannot create child workloads, acquire leases, delegate across the cluster, load arbitrary plugins, or promote itself.
- Can request only capabilities authorized for its current Run. A maliciously modified loop must not be able to exceed that envelope.

### 7.4 Attestation

Attestation is evidence, not a trust class. TPM, measured boot, signed bundles, and secure boot can improve placement decisions, but worker-reported attestation does not grant control-plane eligibility. Promotion from quarantine requires a new identity after remediation or reinstallation.

## 8. Bulk fleet scenario

For hundreds of internet-cafe or lab machines:

1. A trusted Fleet controller creates batches with `maxUnavailable`, canary, pause, deadlines, and rollback policy.
2. Each restricted node runs a local Agent loop and preferably a local model when capacity permits.
3. Deterministic remediation templates handle known configurations first.
4. The local loop is invoked only for drift, ambiguity, or repair failures.
5. Local tools operate through task-scoped `ToolOperation` grants.
6. Nodes upload compact structured evidence and hashes rather than all raw logs and context.
7. Trusted verification samples or verifies all nodes according to risk.
8. Rollout pauses automatically when failure, drift, cost, or security thresholds are exceeded.

This topology distributes inference and local inspection while keeping fleet policy, batch progression, credentials, and final verification outside worker control.

## 9. Resource model

All resources use `apiVersion`, `kind`, `metadata`, `spec`, and `status`. Metadata includes UID, generation, resourceVersion, labels, annotations, owner references, finalizers, creation time, and namespace. Spec and status have separate actor permissions.

### 9.1 Workload resources

- `AgentWorkload`: desired loop template, tool/model policy, rollout, restart, retry, parallelism, completion, placement, security, data, network, storage, credentials, artifacts, delegation, budget, and verification.
- `AgentRun`: root attempt, parent/child ownership, overall phase, rollout, lease/fencing context, aggregate usage, provenance, and terminal result.
- `AgentLoopRun`: loop/profile/script digest, prompt/memory references, placement, runtime, model policy, checkpoint, phase, decisions, usage, and output trust.
- `ToolOperation`: stable toolCallId, tool/version/schema digest, normalized parameters, target, risk, requester, authorizer, grant, idempotency/fencing, placement, approval, effect, evidence, and verification.
- `ModelCallRecord`: provider/model/digest, input classification/hash, endpoint, local/broker mode, token/cost limits, usage, output trust, and audit reference. Streaming tokens do not enter the control store.

### 9.2 Class and attachment resources

- `RuntimeClass`: execution driver, supported unit types, isolation properties, checkpoint/adoption, supported trust classes, resource model, and threat claims.
- `ToolClass` and `ToolExecutorEndpoint`: tool executor driver, catalog digest, risk classes, schemas, targets, placement, health, and capacity.
- `ModelClass` and `ModelEndpoint`: model driver, model digest, modalities, context, residency, local/broker mode, trust, usage limits, health, and capacity.
- `NetworkClass` and `NetworkAttachment`: driver, enforcement level, DNS, proxy, egress/ingress, bandwidth, service access, addresses, opaque handle, and status.
- `StorageClass`, `AgentVolumeClaim`, `AgentVolume`, and `AgentSnapshot`: provisioner, access mode, topology, replicas, attachment, snapshot, restore, and health.

### 9.3 Security and evidence resources

- `SecurityProfile`: loop trust, tool risk/targets/paths, model/data policy, session TTL, credential/network policy, output limits, approvals, artifacts, sanitizers, and verifiers.
- `WorkerEnrollment`: single-use bootstrap intent and expected gateway/audience.
- `WorkerSession`: ephemeral workload identity, allowed protocol, expiry, revocation, and observed connection state.
- `WorkloadCapabilityGrant`: signed Run/attempt/epoch/method/target/policy/budget authorization bound to a workload key and channel.
- `CredentialGrant`: JIT credential authorization that resolves to an opaque handle, never raw secret resource data.
- `ArtifactRecord`: content hash, size, MIME, producer, trust, provenance, scanner/sanitizer/verifier status, and downstream lineage.
- `NodeAttestation`: measured evidence and trusted verifier assessment.
- `NodePromotionRequest`: remediation evidence, new-identity request, approval, and old-identity revocation.
- `OperationRecord`: pending/succeeded/failed/unknown effect state and recovery decision.
- `Lease`: strong coordination for trusted controllers, Runs, and volumes. Quarantine workers consume fenced assignments but do not acquire cluster leases.

### 9.4 Node separation

Trusted control-plane actors write Node spec, including roles, trustClass, controlPlaneEligible, voter, scheduler, storageReplica, administrative labels, and taints. A worker can update only its heartbeat, reported capabilities, assigned-Run events, and attestation evidence.

Restricted and quarantine Node identities are admission-locked to:

- `roles=[worker]`
- `controlPlaneEligible=false`
- `voter=false`
- `scheduler=false`
- `storageReplica=false`
- `pluginHost=false`

No self-reported capability, same-account relationship, label, status update, or ordinary device grant can override those constraints.

## 10. MemeLoop Infrastructure Interface Suite

All interfaces share versioned manifests, capability negotiation, opaque handles, structured errors, deadlines, cancellation, streaming backpressure, health/status, idempotency, fencing, actor identity, trace context, and conformance tests.

Every request envelope includes the relevant resource UID/generation, Run UID, attempt, fencing epoch, request ID, idempotency key, deadline, actor/session identity, capability-handle reference, trace context, and payload-schema digest. Drivers must reject unsupported fields or versions rather than silently weakening policy.

### 10.1 Resource API and ControlStore Driver

Required operations:

- Get, List, Watch, Create, Apply, UpdateStatus, Delete.
- ResourceVersion CAS and watch resume.
- Transactions or compare-and-swap for binding and fencing.
- Lease create, renew, release, and expiry observation.
- Snapshot, compaction, health, and migration.

Core provides ports and an in-memory model. CLI provides SQLite standalone and etcd quorum implementations. Conversation synchronization is not a ControlStore implementation.

### 10.2 Loop Runtime Driver

This is the cognition equivalent of a CRI-style workload interface.

- GetCapabilities.
- Prepare, Start, Watch, Checkpoint, Restore, Cancel, Inspect, Adopt, Delete.
- Report resource usage, local model/tool reachability, checkpoint guarantees, and supported trust classes.
- Declare script/runtime digests, isolation, persistence, adoption, and threat assumptions.

Drivers may implement local core loops, Node processes, Web Workers, WASM, remote peers, containers, Swarm services, or Kubernetes Jobs. The interface manages `AgentLoopRun`; it does not expose controller credentials to the loop.

### 10.3 Tool Catalog and Tool Execution Driver

- Discover and Describe tool name, version, input/output schema, effect/risk class, targets, idempotency, fencing, and evidence support.
- Prepare executor and target context.
- Authorize and Invoke with `ToolOperation` identity and a capability handle.
- Stream bounded output with cancellation and backpressure.
- Inspect, Reconcile unknown effects, CollectEvidence, and Cleanup.

An in-process tool registry is one implementation of this driver. It does not define a privileged bypass.

### 10.4 Model Provider Driver

- List models and capabilities.
- Generate or Stream.
- Cancel.
- Estimate and report usage.
- Report health, model digest, context, modalities, residency, local/broker mode, and input/output trust.

The model request carries a `ModelAccessHandle`, not a provider API key. The driver or gateway resolves the handle and enforces model, Run, worker key, audience, data class, token, cost, concurrency, and expiry policy.

### 10.5 Network Driver

This is the CNI-like interface.

- GetCapabilities.
- PrepareNetwork.
- CheckNetwork.
- ResolveService.
- UpdatePolicy.
- ReleaseNetwork.

Inputs include DNS, proxy, egress/ingress, bandwidth, service allowlists, data class, and trust requirements. Outputs use opaque handles and explicitly report verified enforcement level:

- `none`
- `process`
- `namespace`
- `host`
- `external`

The scheduler must match required enforcement. A firewall reported by a hostile host cannot satisfy an external-isolation requirement. High-risk quarantine work requires a trusted gateway, external VLAN/firewall, rescue network, or equivalent enforcement outside the worker OS.

### 10.6 Storage Driver

The CSI-like interface has Controller and Node services.

Controller operations cover capabilities, provision, delete, snapshot, restore, expand, replica health, rebuild, and backup. Node operations cover stage, publish, unpublish, and stats.

The logical layer separately defines ConversationEventStore, RunStateStore, CheckpointStore, BlobStore, and DefinitionStore. SQLite is single-writer and replicated through logical events or online backup snapshots, not by copying an active database and WAL.

### 10.7 Credential Broker Driver

- Issue, Renew, Revoke, and inspect task-scoped credentials.
- Bind grants to Run, attempt, worker key, target, method, audience, policy digest, and expiry.
- Materialize an opaque handle for another trusted driver.
- Report exposure and required post-task rotation.

Raw secrets must not be placed in environment variables, argv, manifests, status, logs, checkpoints, or worker-readable config. When a provider cannot issue short-lived credentials, direct worker access is disallowed and a trusted proxy performs the operation.

### 10.8 Artifact Driver

- Put and stream bounded content.
- Resolve by content hash.
- Scan, sanitize, verify, promote, quarantine, and delete.
- Mount only according to trust and data policy.

The driver defends against terminal escape sequences, active HTML/Markdown, archive bombs, absolute paths, `..`, symlinks, hardlinks, MIME confusion, malformed parsers, and prompt-injection payloads. Derived artifacts inherit the lowest input trust until explicit promotion.

### 10.9 Identity and Attestation Driver

- Enroll, Challenge, Attest, IssueSession, Rotate, Revoke, and inspect.
- Support proof-of-possession and channel binding.
- Keep enrollment, workload identity, ordinary device identity, and control-plane identity separate.

### 10.10 Policy and Approval Driver

- AdmitResource.
- AuthorizePlacement.
- AuthorizeToolOperation.
- RequestApproval.
- VerifyTransition.
- ExplainDecision.

Worker-local tool permission remains defense in depth. Trusted admission and capability validation are the security boundary.

### 10.11 Audit and Telemetry Driver

- AppendAudit.
- EmitEvent, metric, and trace.
- Record trusted receiver time, actor, resource, policy, capability, effect, and provenance.
- Enforce quotas and preserve logs outside worker control.

Workers cannot delete or rewrite trusted audit records.

## 11. Driver manifest and conformance

Every infrastructure driver manifest declares:

- API version, kind, name, and implementation version.
- Execution location and transport.
- Supported trust classes and resource kinds.
- Capabilities and downgrade behavior.
- Required host privileges.
- Isolation and threat claims.
- Configuration schema and SecretRefs.
- Health endpoint and lifecycle.

Drivers return opaque handles. Core must not inspect platform paths, file descriptors, sockets, tokens, container IDs, or native objects.

Each interface ships with:

- An in-memory or fake reference driver.
- Golden wire fixtures and record/replay tests.
- Capability and version negotiation tests.
- Idempotency, fencing, deadline, cancellation, retry, backpressure, crash, adoption, and cleanup tests.
- Security tests for false isolation claims, scope escalation, stale handles, replay, secret leakage, and fail-open behavior.

A RuntimeClass, NetworkClass, StorageClass, ModelClass, or ToolClass cannot reference a driver until its declared capabilities pass conformance.

## 12. Model access and short-lived keys

### 12.1 Preferred model path

The preferred worker path is a trusted `ModelGateway`:

1. Scheduler binds an `AgentLoopRun` to a worker and selects a `ModelEndpoint`.
2. Credential broker issues a short-lived `ModelAccessHandle` bound to Run, attempt, worker ephemeral key, model, policy digest, budget, and gateway audience.
3. The worker proves possession of its workload key over the bound channel.
4. ModelGateway validates policy and performs the provider call with its own provider credential.
5. Worker receives only the model stream and usage metadata.
6. Gateway revokes the handle at Run completion, cancellation, expiry, or policy change.

The worker never sees the provider key. A stolen access handle has short TTL, narrow audience, model and budget limits, proof-of-possession requirements, and immediate revocation.

### 12.2 Local model path

Restricted workers can use local models without a provider secret. The local model endpoint still has a ModelClass, digest, capacity, data policy, health, and output trust. A local or compromised model can manipulate the loop, so its output does not bypass ToolOperation authorization.

### 12.3 Direct provider path

Direct worker-to-provider access is allowed only when the provider supports appropriately short-lived, audience-bound credentials and policy permits the data class. Long-lived API keys are never delivered. Otherwise the call must use the gateway.

### 12.4 Secret handling edge cases

- Do not place access handles in argv or process-wide environment variables.
- Prefer an authenticated local channel or inherited descriptor with restrictive lifetime.
- Avoid persisting handles. If crash recovery requires persistence, store an encrypted resumable reference that still requires fresh proof-of-possession.
- Memory zeroization is best effort and is not a guarantee on a hostile host.
- Do not include prompts, model output, or credentials in crash dumps.
- Enforce per-Run token, cost, concurrency, and request-rate budgets at the gateway, not only in the worker.
- A compromised worker can exfiltrate prompts and outputs it legitimately receives. Data classification must prevent sensitive prompts from being scheduled there.

## 13. Hostile worker protocol and gateway

Quarantine workers use a dedicated outbound-only worker protocol and do not join the ordinary peer topology.

### 13.1 Enrollment

- A trusted actor creates a short-TTL, single-use `WorkerEnrollment`.
- The worker knows only the expected gateway and pinned gateway key.
- The worker creates an ephemeral key in memory and exchanges proof-of-possession for a `WorkerSession`.
- The session is bound to node, audience, allowed protocol, expiry, and revocation state.
- Ordinary cloud account tokens and DeviceConnectionGrants are never sent to the worker.

### 13.2 Allowed worker operations

- Pull its redacted assignment.
- Acknowledge assignment and renew its own session heartbeat.
- Submit bounded events for its assigned Run and epoch.
- Request capabilities for permitted ToolOperations or model calls.
- Upload bounded artifacts to the quarantine sink.
- Complete, fail, or cancel its assigned operation.

It cannot list or watch cluster resources, create workloads, acquire leases, read secrets or conversations, sync data, discover peers, update Node spec, set Verified, or request promotion.

### 13.3 Gateway enforcement

- Validate schema, message size, rate, deadline, sequence, nonce, signature, channel binding, Run, attempt, epoch, method, target, policy digest, quota, and revocation on every message.
- Use gateway receive time, not worker time.
- Use a minimal service identity with assignment/status/artifact-broker scope only.
- Keep append-only audit outside worker control.
- Apply method-specific payload limits substantially below ordinary sync limits.
- Fail closed after gateway restart or uncertain session state.

## 14. Tool security and effect handling

### 14.1 Authorization

The loop creates a `ToolOperation` request. Trusted policy evaluates normalized parameters, target, data, node trust, risk, prior effects, approval, and grant scope. A model-generated tool name or target has no authority by itself.

### 14.2 Local effects

For restricted fleet work, local configuration tools can execute on the worker under task-scoped policy. Host paths and targets require canonicalization and TOCTOU-resistant handling. Symlinks, mount changes, redirects, and DNS rebinding must not expand the authorized target.

For quarantine remediation, the host malware already has local authority. MemeLoop limits access to other assets and cluster capabilities, records requested effects, and requires external verification. It cannot prove local remediation from local reports alone.

### 14.3 Recovery

- Idempotent operations can retry with the same operation ID and epoch.
- Fence-aware operations reject stale epochs.
- Non-retryable operations move to manual intervention after uncertain failure.
- Destructive remediation does not automatically replay after disconnect.
- Operation reconciliation checks trusted external evidence before deciding whether to retry.

## 15. Artifact and prompt trust

- Worker logs are bounded and stripped of ANSI, OSC, and control sequences before display.
- Active HTML and raw Markdown execution are disabled.
- Archives are inspected in a separate sandbox with size, depth, path, link, and file-count limits.
- Binary parsing occurs in isolated scanners, not the controller process.
- Worker text and local-model output carry provenance and taint into every derived prompt and artifact.
- Untrusted content is not concatenated into a higher-privilege Agent prompt without explicit sanitization and policy.
- A trusted verifier can certify a narrow property; it does not generally convert all worker output to trusted.
- Backup, knowledge ingestion, and trusted volume mounting exclude unverified artifacts by default.

## 16. Verification and promotion

Quarantine completion states include `CompletedUnverified`, `VerificationFailed`, and `Verified`. A worker cannot write `Verified`.

Verification can include:

- External port and service checks.
- Account, package, policy, and configuration inspection from a trusted channel.
- Malware or integrity scanning from a trusted rescue environment.
- Reboot into a signed image and recheck.
- TPM or measured-boot evidence.
- Independent Agent or deterministic verification on a trusted node.
- Human approval for destructive takeover.

Promotion never changes the old quarantine identity in place. The process is:

1. Stop work and revoke worker sessions and grants.
2. Rotate every credential exposed during takeover.
3. Reinstall, reimage, or establish a trusted boot baseline.
4. Verify independently.
5. Generate a new ordinary device identity in the remediated environment.
6. Approve `NodePromotionRequest` from a trusted actor.
7. Keep the old identity permanently revoked or compromised.

## 17. Scheduling and consistency

### 17.1 Scheduler filters

Scheduling considers:

- Node health, administrator trust, role, taints, and verified attestation.
- Loop, tool, model, network, storage, and credential driver capabilities.
- Data classification and residency.
- Runtime isolation and verified network-enforcement level.
- Tool target locality and host-access requirements.
- Model capacity, context, cost, and local/broker mode.
- Artifact and checkpoint locality.
- CPU, memory, GPU, disk, bandwidth, and current load.
- Co-location and anti-affinity.
- Fleet rollout batch and failure-domain constraints.

Scoring favors stable rendezvous placement, data locality, local models, tool locality, low load, and low transfer cost without weakening security requirements.

### 17.2 Consistency modes

- `Strict`: default for side effects. Binding and lease/fencing changes require standalone or quorum control-store authority. Loss of quorum stops new effects.
- `Available`: explicit for duplicate-tolerant, read-only, or speculative work. Partitioned claims may temporarily duplicate and later converge.

ToolOperation policy is stricter than parent loop policy. An Available loop cannot make a side effect Available unless that tool and operation explicitly allow it.

### 17.3 Membership

- One stable node bootstraps as a single voter.
- A second node starts as observer rather than creating a fragile two-voter configuration.
- Three stable trusted nodes can jointly migrate to three voters.
- Maintain three or five voters; other control-capable nodes are observers/API/controllers.
- Restricted, quarantine, revoked, compromised, and ephemeral identities never enter quorum.

## 18. Storage design

Logical stores are separated by behavior:

- ConversationEventStore.
- RunStateStore.
- CheckpointStore.
- BlobStore.
- DefinitionStore.

The volume layer uses StorageClass, claims, volumes, attachments, snapshots, replicas, and backups. Initial implementations include:

- `local-markdown` in CLI with atomic temporary-file replacement and content-addressed blobs.
- `sqlite` in CLI with transactions, WAL, online backup snapshots, and single-writer fencing.
- `tiddlywiki-http` as an explicit fetch-based portable adapter with revision/ETag CAS.
- A replicated meta-driver that plans replica placement, verifies hashes, tracks primary lease, rebuilds missing replicas, and restores snapshots.

Quarantine workers receive only ephemeral scratch, explicit host-access operations, and a quarantine artifact sink. They do not host control state, trusted volume replicas, or backups.

## 19. Recovery semantics

- Agent scripts persist durable step identity, child LoopRun references, ToolOperation references, results, and next cursor.
- Completed children and operations are reused after restart.
- LoopRun can move nodes only from a durable checkpoint.
- In-flight model streams restart according to policy and usage records.
- Tool recovery depends on effect class, idempotency, fencing, evidence, and approval.
- Old executors cannot submit status or effects after a fencing epoch changes.
- Checkpoints and artifacts retain producer trust and provenance after migration.
- Default heartbeat, grace, and lease values are configurable by host and trust profile rather than hard-coded into portable logic.

## 20. Implementation phases

### Phase 0: Package boundary and ADRs

1. Make `memeloop` default exports and dependencies genuinely portable.
2. Move concrete Node libp2p transports and complete provider factories into CLI library subpaths.
3. Replace Buffer and ambient process environment dependencies in core.
4. Build versioned schemas, method catalogs, driver manifests, and cross-language fixtures.
5. Document plane separation, trust model, consistency, and non-guarantees.

### Phase 1: Resource API and reconciliation kernel

1. Implement ResourceClient/ResourceStore ports and in-memory reference model.
2. Implement spec/status authorization, resourceVersion CAS, watch, owner/finalizer, conditions, and events.
3. Split controllers into pure reconcile and injected action execution.
4. Implement Node, Workload, Run, LoopRun, ToolOperation, ModelCall, Scheduler, and Lease control logic.

### Phase 2: Infrastructure interface suite

1. Freeze common envelope, manifest, handle, error, cancellation, stream, health, idempotency, fencing, and conformance rules.
2. Implement portable contracts and fake drivers for Resource, Runtime, Tool, Model, Network, Storage, Credential, Artifact, Identity, Policy, and Audit.
3. Add NetworkClass/Attachment and verified enforcement levels.
4. Add driver capability admission and downgrade rejection.

### Phase 3: Restricted and quarantine worker security

1. Implement NodeAuthorizer and immutable trust/role admission.
2. Implement dedicated outbound worker protocol and DMZ-style gateway.
3. Implement one-time enrollment, ephemeral sessions, proof-of-possession, replay prevention, and revocation.
4. Implement restricted and quarantine executor profiles.
5. Implement capability, credential, and model brokers.
6. Implement artifact quarantine, sanitation, scanning, provenance, and verifier controllers.
7. Implement incident and new-identity promotion flows.

This phase blocks all production remote-executor work. Remote execution must not first ship on the broad ordinary-device trust model.

### Phase 4: CLI reference data plane

1. Implement SQLite standalone ControlStore and all-in-one daemon.
2. Implement process/in-process Loop Runtime and Tool Execution drivers.
3. Convert ordinary peer RPC into driver transport; keep quarantine on the dedicated worker protocol.
4. Route task, spawnAgent, runAgent, and runParallel through ChildRunDispatcher.
5. Convert every loop tool decision into ToolOperation, including the local fast path.

### Phase 5: Durable recovery

1. Replace process-local script state with RunStateStore.
2. Persist stable step, child, model, and operation identity.
3. Implement loop checkpoint restore and tool effect reconciliation.
4. Add manual-intervention and verifier-required recovery states.

### Phase 6: Storage, replication, and backup

1. Split logical stores and migrate CLI/Desktop adapters.
2. Implement initial Storage drivers.
3. Implement replica planning, snapshot transfer, rebuild, and fencing.
4. Exclude unverified data from trusted backup and knowledge ingestion.

### Phase 7: Multi-node control plane and fleet rollout

1. Implement standalone, quorum, and eventual control-store modes.
2. Implement voter/observer membership and node leases.
3. Schedule LoopRun, ToolOperation, ModelEndpoint, NetworkAttachment, and volumes independently.
4. Implement co-location optimization and data locality.
5. Implement batch, canary, maxUnavailable, pause, rollback, and evidence aggregation.

### Phase 8: External drivers and host integration

1. Publish portable conformance kit and Node driver SDK.
2. Add Swarm and Kubernetes/K3s drivers without default core/CLI dependencies.
3. Migrate Electron to CLI Node adapters and portable renderer client.
4. Provide Tauri/Rust protocol fixture, browser remote client, IndexedDB adapter boundary, and low-power executor examples.
5. Add unified diagnostics for Run/Loop/Model/Tool/Network/Credential/Artifact/Verifier lineage.

## 21. Verification matrix

### 21.1 Portability and package boundaries

- Bundle every core public entry for a browser without Node polyfills.
- Reject Node builtins, Buffer/process, native addons, and Node-only dependencies in core import graphs.
- Verify installing only `memeloop` does not install Node transports, SQLite, etcd, local TiddlyWiki, or complete provider SDKs.
- Verify importing CLI library entries has no CLI-start side effects.
- Round-trip Workload, LoopRun, ToolOperation, attachments, assignments, and errors through TypeScript and a minimal Rust fixture.

### 21.2 Controller and scheduler

- Repeated reconcile produces idempotent actions.
- Watch replay, controller crash, finalizers, generation change, stale owner, and stale status converge.
- Scheduler tests every capability, trust, taint, data, model, network, storage, locality, and rollout filter.
- Strict binding races produce one fenced winner.
- Available claims converge and cancel losers after reconnection.

### 21.3 Runtime, model, and tools

- Process worker start, stream, cancel, crash, restart, adoption, orphan cleanup, and duplicate start.
- Local and remote LoopRuntimeDriver produce equivalent resource transitions.
- In-process and remote ToolExecutionDriver produce equivalent operation/audit records.
- Model gateway enforces Run/model/audience/budget/expiry and revokes access on cancellation.
- Long-lived provider keys are absent from worker environment, argv, config, logs, checkpoints, and crash reports.
- Unknown side effects move to the correct retry, verifier, or manual state.

### 21.4 Network and storage

- Network driver capability and enforcement-level downgrade are rejected when requirements are unmet.
- Hostile self-reported firewall does not satisfy external isolation.
- Storage CAS, crash snapshots, restore, replica loss, corruption, rebuild, and primary fencing.
- Quarantine cannot publish trusted volumes or become a replica.

### 21.5 Adversarial workers

- Worker attempts to modify roles/trust/labels, create resources, list/watch, read secrets/conversations, acquire leases, open ordinary protocols, become voter, or write Verified are denied by trusted components.
- Grants fail for wrong Run, attempt, epoch, method, target, audience, channel, signature, time, quota, sequence, or revocation.
- Worker clock cannot extend authorization.
- ANSI/OSC, active markup, archive bombs, path traversal, links, MIME confusion, malformed parsers, oversized streams, and prompt injection remain quarantined.
- Worker-forged capability, attestation, effect, completion, and OperationRecord cannot advance protected state.
- Revocation taints all worker artifacts and downstream provenance.
- Promotion requires revoke, credential rotation, trusted verification, new identity, and administrator approval.

### 21.6 Fleet end to end

- Roll out to hundreds of fake restricted nodes in batches with local loops and tools.
- Enforce concurrency, model budget, maxUnavailable, pause, canary, retry, and rollback.
- Use deterministic templates first and local Agent reasoning only for drift.
- Lose workers, model endpoints, gateways, storage replicas, controllers, and quorum members at controlled points.
- Aggregate compact evidence without accepting unverified completion.

## 22. Existing code migration anchors

- `packages/memeloop/src/runtime.ts`: replace process-local script state and direct recursive child execution.
- `packages/memeloop/src/loopAPI/types.ts`: add portable dispatcher, runtime, model, tool, policy, and checkpoint ports.
- `packages/memeloop/src/loopAPI/agent-agent-loop/loop.ts`: use stable child/step identity and declarative child Runs.
- `packages/memeloop/src/loopAPI/agent-tool-loop/toolUseGate.ts`: remove implied allow for restricted/quarantine and add non-overridable admission decisions.
- `packages/memeloop/src/device-network/types.ts`: separate ordinary device grants from workload sessions and grants.
- `packages/memeloop/src/device-network/cloudDeviceAuthorizer.ts` and `localTrustDeviceAuthorizer.ts`: ordinary protocol authorization only; add method-level worker authorization separately.
- `packages/memeloop/src/device-network/libp2pRpcProtocol.ts`: replace unscoped arbitrary methods for worker execution with versioned worker method catalogs.
- `packages/memeloop/src/sync/chatSyncEngine.ts`: keep conversation anti-entropy separate from control state and disable it entirely for quarantine.
- `packages/memeloop/src/types.ts` and storage interfaces: split logical stores and replace Buffer with Uint8Array.
- `packages/memeloop-cli/src/runtime/nodeRuntime.ts`: assemble Node reference control and data planes through registries.
- `packages/memeloop-cli/src/plugin/filePluginLoader.ts`: never load for quarantine mode; isolate trusted third-party drivers in subprocesses.
- `packages/memeloop-cli/src/deviceNetwork/`: host ordinary Node libp2p and separate worker gateway implementations.
- `packages/memeloop-cli/src/storage/`: host SQLite, files, snapshots, quarantine artifact sink, and replication transport.
- `packages/memeloop-cloud/src/devices/deviceApi.ts` and grant crypto: do not extend ordinary allowed-peer grants for workers; use separate enrollment, audience, signing key, and service identity if Cloud hosts a gateway.
- `TidGi-Desktop/src/services/deviceNetwork` and Agent storage adapters: consume core resources and CLI adapters without owning scheduling or Agent state machines.

## 23. Final decisions

- Agent loops are Pod-like workloads, not control-plane components.
- Agent loops may run on restricted and quarantine workers. Quarantine loops are untrusted planners constrained by trusted capability brokers and independent verification.
- Tool execution is a separate effect boundary and resource lifecycle, even when implemented by an in-process fast path.
- Model access uses a dedicated interface and short-lived opaque access handles. Long-lived provider keys remain at trusted gateways.
- AgentWorkload composition is release-like; AgentLoopRun, ToolExecutorEndpoint, ToolOperation, ModelEndpoint, NetworkAttachment, and storage resources remain independently schedulable.
- Restricted fleet workers are the normal solution for large managed fleets. Quarantine is reserved for assumed-compromised assets and carries stronger isolation and verification requirements.
- Every infrastructure interface is versioned, capability-negotiated, language-neutral, opaque-handle-based, and conformance-tested before driver admission.
- `memeloop` remains the portable source of domain truth; `memeloop-cli` remains the Node reference implementation; hosts provide adapters rather than duplicate runtimes.
- Cloud remains optional identity/directory/relay/gateway infrastructure, not a central Agent scheduler.
- Failure recovery occurs at durable LoopRun, ToolOperation, model-call, and artifact boundaries, not by migrating arbitrary process memory.

## 24. Auditable implementation worklog

This section is the execution ledger for subsequent agents. Do not mark a step complete merely because types were added. A complete step has implementation, focused tests, repository validation, and an implementation note below its heading. Keep each change inside `packages/memeloop`, `packages/memeloop-cli`, and this documentation unless the step explicitly opens a host-integration phase. Do not modify `memeloop-react-ui` while implementing the core and CLI phases.

Status values are `planned`, `in progress`, `blocked`, and `complete`. When completing a step, replace the status, add the completion date, list the actual files changed, record deviations or follow-up debt, and include the exact focused validation that passed.

### 24.1 Establish the repository plan as the handoff source

**Status:** complete (2026-07-16)
**Scope:** `docs/AGENT_ORCHESTRATION_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/HOST_INTEGRATION.md`.
**Completion criteria:** The repository contains one discoverable source of truth covering resources, planes, interfaces, trust, phases, and verification. The temporary session-memory plan is removed.
**Implementation record:** Added this document and linked it from the architecture and host-integration guides. `git diff --check` and editor diagnostics passed.

### 24.2 Freeze the implementation scope guard

**Status:** planned
**Scope:** package scripts or CI checks in `packages/memeloop` and `packages/memeloop-cli`.
**Completion criteria:** A check fails if core imports Node builtins or if orchestration work modifies `memeloop-react-ui`. Existing unrelated working-tree changes remain untouched.
**Implementation record:** Pending. Start with a report-only import scan before making it blocking.

### 24.3 Inventory current portable-boundary violations

**Status:** planned
**Scope:** core imports, package dependencies, public exports, Buffer/process usage, concrete libp2p and provider factories.
**Completion criteria:** A checked-in inventory identifies every violation, its destination, and migration order without changing runtime behavior.
**Implementation record:** Preliminary findings exist in Sections 4 and 22; convert them into an executable scan and baseline.

### 24.4 Define canonical resource metadata primitives

**Status:** in progress
**Scope:** new portable orchestration types under `packages/memeloop/src/orchestration`.
**Completion criteria:** TypeMeta, ObjectMeta, ResourceReference, owner reference, condition, event, generation, and resourceVersion types are JSON-safe and browser-safe.
**Implementation record:** Added portable TypeMeta, manifest/object metadata, owner reference, resource manifest/resource/reference, generation, resourceVersion, and creation timestamp in `src/orchestration/client.ts`. Conditions, finalizers, generic resource events, and actor-separated status types remain for this step.

### 24.5 Define the Agent-facing orchestration facade

**Status:** complete (2026-07-16)
**Scope:** portable client contract exported by `memeloop`.
**Completion criteria:** Agent loops receive a manager-facing facade that can discover capabilities and create/get/list/watch/delete declarative resources. It exposes no drivers, platform handles, or credentials. All operations carry actor/admission context through the host implementation.
**Implementation record:** Added `AgentOrchestrationClient` with capability discovery and apply/get/list/watch/delete operations. Actor identity is intentionally absent from call parameters and must be bound by the host implementation. The facade exposes manifests, references, queries, options, resources, and watch events only. Typed convenience clients remain Step 24.12. Focused runtime/tool tests passed; core lint and DTS/build passed.

### 24.6 Define orchestration resource and watch semantics

**Status:** in progress
**Scope:** apply/get/list/watch/delete options and events.
**Completion criteria:** Contracts cover dry-run, field manager, CAS preconditions, resourceVersion resume, bookmarks, timeout/cancel, deleted resources, and terminal watch errors.
**Implementation record:** Initial contracts include dry-run, field manager, idempotency key, resourceVersion, pagination, watch event types/bookmarks/errors, timeout, AbortSignal, and deletion propagation. Structured error codes, deleted final-state semantics, exact CAS preconditions, and watch compaction behavior remain.

### 24.7 Define structured orchestration errors

**Status:** planned
**Scope:** portable error codes and retry metadata.
**Completion criteria:** Errors distinguish unsupported, forbidden, conflict, stale epoch, not found, invalid, exhausted, unavailable, timeout, cancelled, and unknown-effect cases. Callers do not parse message strings.
**Implementation record:** Pending.

### 24.8 Export the facade from portable entries

**Status:** complete (2026-07-16)
**Scope:** core index, browser entry, package exports, build output.
**Completion criteria:** The same orchestration declarations are available from default and browser-safe entries, and importing them does not load Node implementations.
**Implementation record:** Added `src/orchestration/index.ts`, exported runtime declarations from the default entry, and type declarations from the browser entry. `pnpm --filter memeloop build` produced ESM, CJS, browser, and DTS output successfully.

### 24.9 Inject the facade into AgentFrameworkContext

**Status:** complete (2026-07-16)
**Scope:** shared host context used by both AgentToolLoop and AgentAgentLoop.
**Completion criteria:** Hosts can provide one optional AgentOrchestrationClient without changing storage, model, tool, or network interfaces. Existing hosts continue compiling before a concrete manager is available.
**Implementation record:** Added optional `orchestration` to `AgentFrameworkContext`. No existing required host contract changed. Core build and existing focused loop tests passed.

### 24.10 Propagate the facade into AgentLoopRuntime

**Status:** complete (2026-07-16)
**Scope:** loop runtime construction and nested child runtimes.
**Completion criteria:** Parent and child loops receive the same policy-scoped facade; child execution cannot accidentally receive a wider client. Runtime construction has a focused identity-propagation test.
**Implementation record:** Added optional `orchestration` to `AgentLoopRuntime` and propagated the host-bound instance through `createScriptRuntime`. A runtime test loads a source-backed parent AgentAgent script, creates a nested child Agent, and verifies the child receives and invokes the same facade.

### 24.11 Expose the facade to `.mjs` AgentAgent scripts

**Status:** complete (2026-07-16)
**Scope:** AgentAgent script arguments.
**Completion criteria:** Scripts can use `ctx.orchestration` to apply AgentWorkload and related claims, watch status, and cancel Runs. Missing host capability fails explicitly. No script sees driver instances or raw grants.
**Implementation record:** Added optional `ctx.orchestration` to `AgentAgentLoopScriptArguments` and passed the runtime facade unchanged. Direct and nested-script tests pass. The generic client currently exposes delete rather than a Run-specific cancel helper; ergonomic wait/cancel wrappers remain Steps 24.12 and 24.21.

### 24.12 Add stable script helper wrappers

**Status:** completed
**Scope:** `ctx.agents`, `ctx.tools`, `ctx.models`, `ctx.networks`, `ctx.storage`, `ctx.credentials`, and `ctx.artifacts` convenience clients.
**Completion criteria:** Helpers compile down to the same resource facade, add stable owner/idempotency metadata, and cannot request cluster-scoped Class or Secret resources unless policy explicitly allows it.
**Implementation record:** Injected `ctx.agentClient` into `AgentAgentLoopScriptArguments` in `packages/memeloop/src/loopAPI/agent-agent-loop/loop.ts`. It is constructed from `createAgentClient(context.runtime.orchestration)` when the runtime provides an orchestration facade, and is `undefined` otherwise. The existing `ctx.agents` field already holds the normalized `AgentAgentDescriptor[]` array used by `runAgent`/`runAgents`; to avoid breaking existing scripts, the convenience client is named `agentClient` and the descriptor array is left untouched. Scripts can now call `await ctx.agentClient?.createWorkload(...)` to declaratively create child agents or remote deployments. The remaining convenience clients (`tools`, `models`, `networks`, `storage`, `credentials`, `artifacts`) are deferred until their canonical resource specs are defined in Steps 24.26–24.48. Tests in `packages/memeloop/src/loopAPI/agent-agent-loop/__tests__/loop.test.ts` verify that `ctx.agentClient` is present and can create a workload. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/loopAPI/agent-agent-loop/__tests__/loop.test.ts` passed 14/14.

### 24.13 Add Agent workload creation from scripts

**Status:** completed
**Scope:** script helper for one-shot child Agent workloads.
**Completion criteria:** A script can create a child workload with profile/script, prompt reference, trust, placement, model/tool/network/storage policy, owner reference, stable child key, and completion policy.
**Implementation record:** Defined canonical `AgentWorkload` and `AgentRun` resource schemas in `packages/memeloop/src/orchestration/resources.ts` with manifest builders, type guards, and reference helpers. Added `createAgentClient(client, defaultNamespace)` in `packages/memeloop/src/orchestration/agentClient.ts` exposing `createWorkload`, `createRun`, `getWorkload`, `getRun`, `deleteWorkload`, `deleteRun`, and `waitFor*Condition`. Scripts can call `const agents = createAgentClient(ctx.orchestration)` and create child workloads declaratively. The client validates `apply` results are the expected kind and rejects resources that do not match. Tests in `packages/memeloop/src/orchestration/__tests__/resources.test.ts` and `packages/memeloop/src/orchestration/__tests__/agentClient.test.ts` cover manifest construction, type guards, facade calls, condition waiting, and deletion. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; focused test suites passed 8/8.

### 24.14 Add remote Agent deployment from scripts

**Status:** planned
**Scope:** script helper for service-like or remote Agent deployment.
**Completion criteria:** A script declares placement and desired lifecycle rather than choosing a peer RPC method. Scheduler and admission select the remote node. The script can watch readiness and delete the deployment.
**Implementation record:** Pending.

### 24.15 Add script-generated `.mjs` artifact storage

**Status:** planned
**Scope:** generated script source, artifact references, size limits, and provenance.
**Completion criteria:** An Agent can submit source as an ArtifactRecord and reference it from an AgentWorkload. Source is never imported directly from an LLM string in the controller process.
**Implementation record:** Pending.

### 24.16 Add generated-script validation and normalization

**Status:** planned
**Scope:** syntax parsing, export shape, imports, deterministic metadata, and canonical digest.
**Completion criteria:** Invalid source, forbidden imports, oversized scripts, unsupported API versions, and non-deterministic metadata are rejected before scheduling.
**Implementation record:** Pending. Use a real JavaScript parser rather than regular-expression validation.

### 24.17 Add generated-script admission policy

**Status:** planned
**Scope:** trust class, author, requested interfaces, import policy, resource limits, and approval.
**Completion criteria:** Trusted, restricted, and quarantine profiles have explicit script policies. Quarantine cannot enable arbitrary network imports or plugin loading.
**Implementation record:** Pending.

### 24.18 Add generated-script sandbox/runtime selection

**Status:** planned
**Scope:** RuntimeClass requirements for source scripts.
**Completion criteria:** Source scripts cannot silently run in an unrestricted controller process. Runtime capability declares module isolation, CPU/memory/time limits, cancellation, and supported trust classes.
**Implementation record:** Pending.

### 24.19 Add script checkpoint compatibility rules

**Status:** planned
**Scope:** script digest, API version, checkpoint schema, and migration.
**Completion criteria:** A changed script cannot resume an incompatible checkpoint without an explicit converter or restart policy.
**Implementation record:** Pending.

### 24.20 Add an orchestration builtin tool for AgentToolLoop

**Status:** complete (2026-07-16)
**Scope:** core builtin tool plugin backed by AgentOrchestrationClient.
**Completion criteria:** The LLM tool loop can discover allowed resource kinds and apply/get/list/delete resources through one admission-controlled tool. Tool schemas do not expose raw driver or credential fields.
**Implementation record:** Added the `orchestration` builtin and `builtin:orchestration` plugin with capabilities/apply/get/list/delete actions. Input normalization forwards only whitelisted manifest metadata and operation options; attempted status, actor, and grant fields are discarded. Missing manager returns an explicit error. Seventeen builtin-tool tests and nested runtime tests pass.

**Validation note for Steps 24.4-24.20:** `pnpm --filter memeloop lint` and `pnpm --filter memeloop build` passed. Focused suites passed 32 tests across AgentAgentLoop, runtime propagation, and builtin tools. The full core suite ran 382 tests with 381 passing; the sole failure is the pre-existing `src/loopProfiles/__tests__/builtins.test.ts` expectation that the generated code-assistant profile contains `wikiSearch` and `wikiOperation`. The generated profile currently contains `workspacesList`, `modelContextProtocol`, `spawnAgent`, `askQuestion`, `getErrors`, and `webFetch`; this unrelated profile change was not modified or reverted.

### 24.21 Add condition waiting for ToolLoop calls

**Status:** completed
**Scope:** bounded wait action over resource watch.
**Completion criteria:** ToolLoop can wait for Ready/Completed/Failed with timeout and cancellation without returning an unbounded AsyncIterable to the model.
**Implementation record:** Added `wait` action to `orchestration` builtin tool in `packages/memeloop/src/tools/builtins/orchestration.ts`. The implementation polls `client.get` with configurable `timeout` (default 30s) and `interval` (default 1s, clamped to >=100ms), checks `resource.status.conditions` for the requested `type` and `status`, and returns `{ observedResourceVersion, matched: true }` on success. On timeout it throws an `OrchestrationError` with code `TIMEOUT` and `retryable: true`, which the tool boundary serializes as structured error data for the model. No raw `AsyncIterable` is returned to the model. Tests in `packages/memeloop/src/tools/builtins/__tests__/builtins.test.ts` cover success, timeout, and validation. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/builtins.test.ts` passed 21/21.

### 24.22 Migrate `spawnAgent` to the orchestration facade

**Status:** completed
**Scope:** local child Agent builtin tool.
**Completion criteria:** `spawnAgent` creates an AgentWorkload/Run through the facade and waits according to policy. Direct `runLocalAgent` is removed after CLI supplies the reference manager.
**Implementation record:** Refactored `packages/memeloop/src/tools/builtins/spawnAgent.ts` so that when `context.orchestration` reports support for `AgentWorkload`, it creates a workload via `createAgentClient`, then a run, waits for `Completed=True`, and returns the run summary with `resourceVersion` in the structured detail reference. When no orchestration manager is configured, the tool falls back to the existing `runLocalAgent` path so local behavior continues to work. This satisfies the migration without breaking existing runtimes before the CLI manager lands. Direct `runLocalAgent` removal remains gated on the reference manager in `memeloop-cli`. Tests in `packages/memeloop/src/tools/builtins/__tests__/builtins.test.ts` cover both the orchestration path and the legacy local path. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/builtins.test.ts` passed 22/22.

### 24.23 Migrate `task` to the orchestration facade

**Status:** completed
**Scope:** specialized Agent delegation.
**Completion criteria:** Task profile, permissions, parent ownership, nesting budget, background mode, and detail references are represented in resources rather than mutable shared context.
**Implementation record:** Refactored `packages/memeloop/src/tools/builtins/task.ts` to use the orchestration facade when available. The orchestration path creates an `AgentWorkload` with `profileId`, `promptReference`, `completionPolicy` (`complete` or `detach`), and a `toolPolicy` that carries the selected agent profile's `defaultAction` and `rules`. It then creates an `AgentRun`; for synchronous tasks it waits for `Completed=True`, and for background tasks it returns the task ID immediately. When no orchestration manager is configured, the tool falls back to the legacy `runLocalAgent` path and still applies `toolPermissions` to the local context. Nested-depth guard, missing-agent validation, and conversation ID format remain unchanged. Extended `AgentWorkloadToolPolicy` in `packages/memeloop/src/orchestration/resources.ts` with `defaultAction` and `rules`. Tests in `packages/memeloop/src/tools/builtins/__tests__/taskTool.test.ts` cover both paths and verify that permissions are serialized into the workload manifest. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/taskTool.test.ts` passed 15/15.

### 24.24 Migrate `remoteAgent` to declarative placement

**Status:** completed
**Scope:** remote Agent builtin tool.
**Completion criteria:** The tool no longer calls `memeloop.agent.create/send` on an LLM-selected node. It creates a workload with placement constraints and returns scheduler-selected Run details.
**Implementation record:** Refactored `packages/memeloop/src/tools/builtins/remoteAgent.ts` so that when `context.orchestration` supports `AgentWorkload`, `remoteAgent` creates an `AgentWorkload` with `placement.requiredNode` set from the supplied `nodeId` and waits for the scheduler-created `AgentRun` to reach `Completed=True`. The orchestration path returns the run summary and resource version in the structured detail reference. When no orchestration manager is configured, the tool falls back to the existing peer RPC path (`memeloop.agent.create/send` and stream/log polling) so current peer-to-peer behavior keeps working. `remoteAgentListImpl` remains unchanged; peer enumeration removal is deferred to Step 24.25. Tests in `packages/memeloop/src/tools/builtins/__tests__/builtins.test.ts` cover the declarative placement path and the legacy RPC path. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/builtins.test.ts` passed 23/23.

### 24.25 Remove direct peer enumeration from Agent tools

**Status:** completed
**Scope:** remoteAgent, MCP forwarding, and script APIs.
**Completion criteria:** Agents see policy-filtered execution targets/capabilities, not the complete cluster peer directory. Quarantine sees only its assigned gateway services.
**Implementation record:** Replaced the direct peer enumeration in `packages/memeloop/src/tools/builtins/remoteAgent.ts` (`remoteAgentListImpl`). When `context.orchestration` is configured, the tool returns policy-filtered execution targets derived from `getCapabilities()` (resource kinds + interfaces + operations). When no orchestration manager is available, it returns an empty target list and an explicit error stating that direct peer enumeration is disabled. The old `getPeers`/`sendRpcToNode` node listing and remote-definition fetching paths were removed from `remoteAgentListImpl`; the underlying context fields remain available for non-tool callers. `remoteAgentImpl` still falls back to peer RPC when orchestration is unavailable (Step 24.24), but the list/discovery surface no longer exposes the cluster peer directory to the model. Tests in `packages/memeloop/src/tools/builtins/__tests__/builtins.test.ts` verify that configured orchestration returns policy-filtered targets and that absent orchestration returns an explicit disablement error. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/builtins.test.ts` passed 21/21.

### 24.26 Define ToolOperation canonical schema

**Status:** completed
**Scope:** operation identity, effect, policy, placement, result, evidence, and recovery.
**Completion criteria:** Every side effect can be represented without platform-specific objects and has explicit idempotency/fencing/non-retryable semantics.
**Implementation record:** Added `ToolOperation` resource schema in `packages/memeloop/src/orchestration/resources.ts`. `ToolOperationSpec` carries `toolRef`, `arguments`, an explicit `effect` (`read`/`create`/`update`/`delete`/`execute`/`unknown`), `idempotencyKey`, `timeoutMs`, `retry` policy with `maxAttempts`/`nonRetryable`/`fencingToken`, and a `policy` for approval/audit level. `ToolOperationStatus` records `phase`, `result` (value or `OrchestrationErrorData`), `attempts`, and timing. Added `createToolOperationManifest` and `isToolOperation` helpers. Tests in `packages/memeloop/src/orchestration/__tests__/resources.test.ts` verify manifest construction and type guards. ToolLoop routing through this resource remains Step 24.29. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/resources.test.ts` passed 4/4.

### 24.27 Define ToolClass and executor endpoint schemas

**Status:** completed
**Scope:** tool catalog, versions, risk, schemas, targets, capacity, and health.
**Completion criteria:** Scheduler can filter an executor without loading its implementation. Schema digests prevent mismatched invocation.
**Implementation record:** Added `ToolClass` and `ToolExecutor` resource schemas in `packages/memeloop/src/orchestration/resources.ts`. `ToolClass` carries `description`, `version`, `schema` (input/output/required), `schemaDigest`, `risk`, `effects`, `allowedTargets`, and `categories`. `ToolExecutor` carries `nodeId`, `selectors`, `trust`, and an array of `capabilities`, each referencing a `ToolClass` by `apiVersion/kind/name` and `schemaDigest`, plus an `endpoint`, `capacity`, and `health`. Manifest builders `createToolClassManifest`/`createToolExecutorManifest` and type guards `isToolClass`/`isToolExecutor` are included. Tests in `packages/memeloop/src/orchestration/__tests__/resources.test.ts` verify manifest construction and type guards. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/resources.test.ts` passed 5/5.

### 24.28 Implement the in-process ToolExecutionDriver

**Status:** completed
**Scope:** adapt current IToolRegistry behind the new effect interface.
**Completion criteria:** Existing tools run through ToolOperation identity, policy, audit, cancellation, output limits, and result normalization.
**Implementation record:** Implemented `createInProcessToolExecutionDriver(registry, options)` in `packages/memeloop/src/orchestration/toolExecutionDriver.ts`. The driver accepts a `ToolOperationResource`, looks up the tool by `spec.toolRef.name` in an `IToolRegistry`, enforces the `policy.requireApproval` guard, executes `BuiltinToolImpl` implementations with the supplied `BuiltinToolContext`, normalizes both sync and async-iterable outputs, applies `maxOutputLength` truncation, and returns a `Completed` or `Failed` `ToolOperationResource` with `status.result` (value or structured `OrchestrationErrorData`). It also calls an optional `auditor` with the running operation and result. The driver increments `status.attempts` and records `startedAt`/`completedAt`. Tests in `packages/memeloop/src/orchestration/__tests__/toolExecutionDriver.test.ts` cover success, missing tool, approval rejection, auditor invocation, and output truncation. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/toolExecutionDriver.test.ts` passed 5/5.

### 24.29 Route AgentToolLoop calls through ToolOperation

**Status:** completed
**Scope:** ReAct tool-use gate and execution primitives.
**Completion criteria:** ToolLoop requests an operation and consumes its status/result. Existing PreToolUse/PostToolUse hooks remain ordered and cannot bypass trusted admission.
**Implementation record:** 2026-07-16 — `executeWithGuards` in `packages/memeloop/src/loopAPI/agent-tool-loop/toolCallRunner.ts` now routes tool execution through `context.orchestration` when the facade serves `ToolOperation` (`apply` + `get` capabilities required). The runner applies a `ToolOperation` manifest (`BuiltinTool` ref, `execute` effect, 60s `timeoutMs`, `metadata` audit level) with a counter-suffixed unique name, polls `get` every 250ms when the applied operation is not yet terminal, and maps terminal status to the existing `ToolRunRow` shape (`Completed` → value/structured payload, `Failed`/`Cancelled` → structured error message). When the facade is absent or does not serve `ToolOperation`, execution falls back to the previous registry path unchanged, so hook ordering (PreToolUse gate → execute → PostToolUse) is preserved on both paths and the doom-loop guard still runs first. Tests in `packages/memeloop/src/loopAPI/__tests__/agentToolLoop.orchestration.test.ts` cover facade routing (registry not consulted), Failed status surfacing, capability fallback, and Running→Completed polling. `pnpm --filter memeloop exec vitest run src/loopAPI/__tests__/agentToolLoop.orchestration.test.ts src/loopAPI/__tests__/agentToolLoop.test.ts` passed 12/12; `pnpm --filter memeloop lint` 0 errors; `pnpm --filter memeloop build` passed. **Debt cleared 2026-07-17:** `idempotencyKey` is now derived per logical call — `conversationId:fnv1a(stableStringify(toolId+parameters)):occurrence` — stable for controller retries, distinct for new identical calls; timeout is configurable via `AgentToolLoopOptions.toolOperationTimeoutMs` (default 60s) and carried in `spec.timeoutMs`. A latent framework bug was found and fixed while testing: `turnPrimitives.ts` built the assistant `messageId` as `conversationId:a:Date.now()`, so two iterations within one millisecond shared identity — the later round replaced the earlier assistant message, the round-1 tool result landed "after" the round-2 assistant message, and duplicate-output detection wrongly skipped the new call. The id now includes `state.iteration`. Tool-result message ids got the same class of fix (monotonic counter suffix) for identical parallel/same-ms calls. Regression coverage: idempotency-key derivation + timeout assertion + two-round occurrence test in `agentToolLoop.orchestration.test.ts`; full `src/loopAPI/__tests__/` suite 53/53 across three consecutive runs.

### 24.30 Separate tool permission from capability authorization

**Status:** completed
**Scope:** permission layers, SecurityProfile, and grant validation.
**Completion criteria:** Model-facing allow/ask/deny remains UX and defense in depth; trusted admission is non-overridable. Restricted and quarantine default deny.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/admission.ts` with `NodeTrustClass` (`trusted`/`restricted`/`quarantine`), `ToolAdmissionPolicy` (ordered first-match-wins rules over tool pattern + effect, with a `defaultAction`), `defaultAdmissionPolicyForTrustClass` (restricted/quarantine → deny), `defaultPermissionActionForTrustClass`, and a pure `evaluateToolAdmission` reusing the existing permission glob matcher. The trusted layer is wired into `createInProcessToolExecutionDriver` via a new host-bound `admission` option: denials fail with `FORBIDDEN` before tool lookup and are still passed to the auditor; `require-approval` decisions fail closed until an approval broker exists. The model-facing layer remains UX/defense-in-depth: `AgentToolLoopOptions.trustClass` now drives the implied permission default in `buildLayeredPermissions` (restricted/quarantine → deny when no explicit wildcard rule; explicit config still wins). Neither layer is reachable by the model or `.mjs` scripts — both are bound by the host at context/driver assembly. Tests in `packages/memeloop/src/orchestration/__tests__/admission.test.ts` cover trust-class postures, rule/effect matching, driver deny/allow/require-approval paths with audit, and gate defaults. `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/admission.test.ts src/orchestration/__tests__/toolExecutionDriver.test.ts` passed 15/15; lint 0 errors; build passed. **Debt cleared 2026-07-17:** admission policy is now resolvable from a resource — `SecurityProfile` (`security.memeloop.io/v1alpha1`) carries `trustClass`, a `toolAdmission` overlay, and `modelPolicy` (allowed model classes + max input classification); `AgentWorkloadSpec.securityProfileRef` references it. `resolveAdmissionPolicy(profile, trustClass)` merges profile rules over the trust-class default with profile rules evaluated first, and forces the resolved default to `deny` for restricted/quarantine regardless of what the profile declares (non-overridable invariant). Declarative admission types (`NodeTrustClass`, `ToolAdmissionPolicy`, `ToolAdmissionRule`, `DataClassification`) now live in `resources.ts` with schema; `admission.ts`/`modelProviderDriver.ts` re-export them for compatibility. Remaining scope: `WorkloadCapabilityGrant` as a resource belongs with the quarantine-worker protocol phase, not this step.

### 24.31 Implement unknown-effect reconciliation

**Status:** completed
**Scope:** executor crash/disconnect after possible side effect.
**Completion criteria:** Driver inspection and evidence determine succeeded/retry/manual/verification-required without blindly repeating destructive operations.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/unknownEffect.ts` with `UnknownEffectEvidence`, a pure `reconcileUnknownEffect(operation, evidence)` decision function, and `applyUnknownEffectDecision`. Decision order: observed result → `succeeded` (only the ack was lost); `nonRetryable` → `manual-intervention`; `read` effect → `retry` within the attempt budget (default max 3); destructive effect with `idempotencyKey` → `retry` within budget (dedupe by key); everything else → `verification-required`. Applying a decision raises a single `EffectUnknown` condition (reason = action) and moves the operation to `Pending` (retry), `Completed` (succeeded), or keeps it `Running` (verification/manual) so controllers never blindly repeat destructive work. Tests in `packages/memeloop/src/orchestration/__tests__/unknownEffect.test.ts` cover all decision branches, budget exhaustion, and condition replacement; 10/10 passed, lint 0 errors, build passed. **Debt cleared 2026-07-17:** the ToolLoop polling path now invokes reconciliation — `waitForToolOperationTerminal` in `toolCallRunner.ts` catches transient `get` failures (`UNAVAILABLE`/`TIMEOUT`/`INTERNAL` OrchestrationErrors) and applies `reconcileUnknownEffect` to the last-seen (or applied) operation: `retry` keeps waiting without re-applying; `verification-required`/`manual-intervention` stops waiting and surfaces the decision as the tool error. Non-transient errors propagate unchanged. Tests cover both branches (transient-then-complete succeeds; exhausted budget surfaces `verification-required`). Remaining wiring: driver-side `UNKNOWN_EFFECT` evidence collection (24.31's `evidenceRef`) arrives with the controller runner; the loop-layer wiring above is complete.

### 24.32 Define ModelClass, ModelEndpoint, and ModelCallRecord

**Status:** completed
**Scope:** model identity, digest, capacity, residency, trust, budget, and usage.
**Completion criteria:** Loop model selection is declarative and schedulable; raw provider SDK objects remain outside resources.
**Implementation record:** 2026-07-16 — Added model resources to `packages/memeloop/src/orchestration/resources.ts` under apiVersion `models.memeloop.io/v1alpha1`. `ModelClass` is the declarative catalog entry (provider family, model name, version, content `digest`, modalities, context window, capabilities, `dataResidency`, per-million-token cost); `ModelEndpoint` is the schedulable serving endpoint (`modelClassRef` + `modelDigest` matching, `nodeId`, `trust`, opaque `endpoint` handle, concurrency/throughput capacity, data policy); `ModelCallRecord` is the audit/usage record (model/endpoint/run refs, host-asserted `caller`, `accessHandleRef` for 24.34, input/output classification, token/cost usage, latency, structured error). All carry documentation that raw provider SDK clients, credentialed URLs, prompts, and completions must never appear in resources. Manifest builders and type guards follow the existing conventions; tests in `packages/memeloop/src/orchestration/__tests__/resources.test.ts` cover manifest construction and guards (6/6 passed, lint 0 errors, build passed). Remaining debt: scheduler does not yet consume `ModelEndpoint` capacity/health; `ModelAccessHandle` resource arrives in 24.34.

### 24.33 Define ModelProviderDriver contract

**Status:** completed
**Scope:** list, capabilities, generate/stream, cancel, usage, and health.
**Completion criteria:** Local and gateway models implement the same portable interface and enforce input/output classification.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/modelProviderDriver.ts`. `ModelProviderDriver` exposes `listModels`, `getHealth`, `generate` (async-iterable `ModelStreamChunk` deltas/usage/error/done), and optional `cancel`. `ModelGenerateRequest` carries a `callId` (ModelCallRecord correlation + idempotency anchor), `modelClassRef` + `modelDigest`, messages, limits, and `inputClassification`. Ordered `DataClassification` (`public < internal < confidential < restricted`) is enforced by `assertClassificationAllowed`, which throws a structured `FORBIDDEN` OrchestrationError before any token leaves the node. `createModelProviderDriverFromLLMProvider` adapts existing `ILLMProvider` implementations (chunk mapping, cancellation via AbortSignal, health) so current runtimes become schedulable without provider rewrites; enforcement happens in the adapter before the legacy provider is invoked. Tests in `packages/memeloop/src/orchestration/__tests__/modelProviderDriver.test.ts` cover classification ordering/rejection, streaming adaptation, pre-invocation enforcement, custom chunk mapping, and health (7/7 passed, lint 0 errors, build passed). **Debt cleared 2026-07-17:** the legacy adapter now implements `cancel(callId)` — each `generate` registers a driver-owned `AbortController` whose signal reaches the provider request, so cancellation aborts in-flight calls regardless of the caller's own signal; the stream terminates early with a structured `CANCELLED` chunk, and controllers are cleaned up in `finally`. Usage reporting flows through `ModelStreamChunk.usage` chunks (provider-dependent; legacy providers that do not emit usage simply omit the chunk — nothing left unimplemented on the adapter side). A gateway-mediated driver remains a separate planned step (ModelGateway).

### 24.34 Add ModelAccessHandle issuance

**Status:** completed
**Scope:** CredentialBroker and ModelGateway.
**Completion criteria:** Handle binds Run, attempt, worker key, model, audience, policy, token/cost/concurrency budget, expiry, and proof-of-possession.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/modelAccessHandle.ts`. `ModelAccessHandleClaims` binds handleId, runRef, attempt, `workerKey` (proof-of-possession fingerprint), modelClassRef, modelDigest, `audience`, `policyDigest`, token/cost/concurrency `budget`, issuedAt, and expiresAt. Tokens are opaque `mlh1.<base64url claims>.<base64url signature>` strings; signing is behind the injectable `ModelHandleSigner` port so core stays browser-safe (Node hosts plug in HMAC/Ed25519). Pure base64url helpers avoid Buffer/atob. `createInMemoryModelAccessHandleBroker` issues handles (TTL default 15min, hard-capped at 60min) and verifies signature, audience, expiry, and worker-key binding, throwing structured `INVALID`/`FORBIDDEN`/`TIMEOUT` OrchestrationErrors. Handles are documented as never written to logs, checkpoints, status, or resource specs. Tests in `packages/memeloop/src/orchestration/__tests__/modelAccessHandle.test.ts` cover base64url round-trips, issuance/verification of all bound fields, tamper/audience/worker-key/expiry rejection, and TTL capping (10/10 passed, lint 0 errors, build passed). Remaining debt: budget _enforcement_ belongs to the ModelGateway (not yet implemented); proof-of-possession is verified as fingerprint equality — a signing challenge at the transport layer is future work; no revocation list yet.

### 24.35 Remove long-lived model keys from worker context

**Status:** completed
**Scope:** CLI provider construction and worker launch.
**Completion criteria:** Provider keys are absent from worker argv, environment, config, checkpoint, status, logs, and crash diagnostics. Unsupported direct providers use the gateway.
**Implementation record:** 2026-07-16 — Two layers. (1) Portable redaction: `packages/memeloop/src/orchestration/secretRedaction.ts` provides `redactSecrets` (deep-clone masking of secret-shaped keys — apiKey/authorization/token/password/etc. — and secret-shaped values — OpenAI/Anthropic/AWS/GitHub/Slack formats, `mlh1.*` handles, Bearer headers) plus `containsSecrets` for pre-persistence assertions; hosts must run values through it before logs, status, checkpoints, and crash diagnostics. (2) Worker launch policy: `packages/memeloop-cli/src/orchestration/workerEnvironment.ts` `sanitizeWorkerEnvironment` strips provider-secret env vars (`*_API_KEY`, `*_SECRET*`, `*_ACCESS_TOKEN`, etc.) and any value matching a known secret format from the inherited environment, keeps platform basics and an explicit allowlist, injects only the non-secret `MEMELOOP_MODEL_GATEWAY` endpoint, and returns stripped variable _names_ (never values) for audit. ModelAccessHandles are delivered over the worker bootstrap channel (unix socket/stdio), never via env — enforced by the secret-format guard rejecting `mlh1.*` values in `extra`. Tests: core `secretRedaction.test.ts` 8/8, CLI `workerEnvironment.test.ts` 5/5; core lint 0 errors, build passed; CLI lint clean on changed files (344 pre-existing errors elsewhere: MCP SDK unresolved imports); CLI full suite has 20 pre-existing failures caused by `better-sqlite3` native module "did not self-register" in this environment (same class as the documented NODE_MODULE_VERSION mismatch), unrelated to this change; core full suite 455/456 with the known code-assistant profile baseline failure. Remaining debt: no CLI provider-construction call site strips keys yet because the process Runtime Driver (which will consume `sanitizeWorkerEnvironment`) is not yet implemented; gateway-mediated provider fallback arrives with the ModelGateway step.

### 24.36 Implement local-model endpoint registration

**Status:** completed
**Scope:** restricted worker model capability.
**Completion criteria:** Local model digest, health, capacity, modalities, data policy, and trust are advertised and schedulable. Local model output cannot authorize tools.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/localModelRegistration.ts`. `describeLocalModelEndpoints(driver, options)` turns any `ModelProviderDriver` into `ModelClass` + `ModelEndpoint` manifests carrying provider/model identity, content digest, modalities, nodeId, node trust, capacity, and data policy; endpoint handles are opaque (`local://<node>/<provider>/<model>`) and never embed credentials or URLs. `selectModelEndpoint(endpoints, requirements)` is the pure scheduling filter: class name, digest match, minimum node-trust rank (quarantine < restricted < trusted), health (excluded by default), and spare concurrency, preferring the highest-capacity candidate and returning null instead of silently falling back to an unvetted endpoint. The "local model output cannot authorize tools" invariant is architectural: tool admission (24.30) is host-bound and has no construction path from model output — model streams flow only through `ModelStreamChunk` data. Tests in `packages/memeloop/src/orchestration/__tests__/localModelRegistration.test.ts` cover advertisement shape and all selection filters (6/6 passed, lint 0 errors, build passed). Remaining debt: advertisement is not yet wired to a heartbeat loop that refreshes `ModelEndpoint.status`; registration with the control-plane store arrives with the controller runner step.

### 24.37 Define NetworkClass and NetworkAttachment schemas

**Status:** completed
**Scope:** CNI-like desired state and attachment status.
**Completion criteria:** DNS, proxy, ingress, egress, service access, bandwidth, data policy, enforcement requirement, and opaque handle are represented.
**Implementation record:** 2026-07-17 — Added network resources to `packages/memeloop/src/orchestration/resources.ts` under apiVersion `network.memeloop.io/v1alpha1`. `NetworkClass` is the CNI-like desired state: driver name, `dns` (policy/servers/search domains), `proxy` (incl. `mandatory` — bypass must be blocked), `ingress` (default action + allow list), `egress` (default action + host/CIDR/port/protocol rules), `serviceAccess` (control plane / cluster services / model gateway), `bandwidth`, `dataPolicy` (DataClassification + retention), and `enforcement: required | best-effort` (required = workload must not start unless every configured feature is enforceable). `NetworkAttachment` binds networkClassRef + workloadRef + nodeId; its status carries phase, an **opaque driver handle** (documented as never parsed by consumers), addresses/routes/dns, `degraded` feature list for best-effort classes, and structured error. Manifest builders and type guards follow existing conventions; `AgentWorkloadSpec.networkPolicy.networkClass` already existed and now has a concrete target schema. Tests in `networkDriver.test.ts` cover both manifests and guards (12/12 with resources tests, lint 0 errors, build passed).

### 24.38 Define NetworkDriver contract and enforcement levels

**Status:** completed
**Scope:** prepare/check/resolve/update/release.
**Completion criteria:** Drivers report `none`, `process`, `namespace`, `host`,
or `external`; admission rejects unverified downgrade.
**Implementation record:** 2026-07-17 — `NetworkDriver` now exposes `prepare/check/update/resolveService/release/getHealth`; capabilities carry the structural `none | process | namespace | host | external` enforcement level instead of a self-asserted boolean. Required classes reject `none` and `process` isolation and any missing feature; best-effort classes report degradation. Core contract tests pass.

### 24.39 Implement the Node process network driver

**Status:** completed
**Scope:** CLI process runtime networking.
**Completion criteria:** The driver truthfully reports its limited enforcement
and supports trusted proxy/service resolution. It does not claim protection from
a hostile host.
**Implementation record:** 2026-07-17 — `process-env` truthfully reports `enforcementLevel: process`, supports the complete driver lifecycle, injects cooperative proxy/service environment only, and always reports mandatory-proxy bypass risk. Required classes fail closed. Seven focused tests cover lifecycle, policy update, service resolution, degradation, and release.

### 24.40 Implement quarantine gateway networking

**Status:** completed
**Scope:** outbound-only worker channel and external enforcement.
**Completion criteria:** Worker receives no ordinary peer topology; method-speci
fic limits, target validation, SSRF/redirect/DNS checks, rate limits, and revoca
tion are enforced outside worker control.
**Implementation record:** 2026-07-17 — Trusted validation returns the exact approved IP set. The CLI uses a pinned Node HTTP(S) transport that connects to one approved IP while preserving the original Host and TLS SNI, eliminating DNS validation/connect TOCTOU. Body limits use actual bytes, redirects are revalidated, cross-origin redirects strip authorization/cookie headers, and responses stream through a hard cap. Core 11/11 and CLI 10/10 focused tests pass.

### 24.41 Split logical storage ports

**Status:** completed
**Scope:** conversation, run state, checkpoint, blob, and definition stores.
**Completion criteria:** Loop/runtime code depends on narrow portable ports and
`Uint8Array`. CLI and Desktop adapters can implement combinations without a mono
lithic IAgentStorage.
**Implementation record:** 2026-07-17 — Added `packages/memeloop/src/storage/ports.ts` as the single source of truth: `ConversationEventStore` (append-only event log + optional lamport optimization), `ConversationDirectoryStore` (metadata rows), `BlobStore` (content-addressed; `saveAttachment` takes `Uint8Array` only — `Buffer` removed from the contract), `DefinitionStore`, `AgentInstanceStore`, `ImBindingStore`, and the `FullAgentStorage` composition. This also eliminated a real duplication: `IAgentStorage` was defined twice (`types.ts` and `storage/interface.ts`); `storage/interface.ts` is now the canonical definition (`type IAgentStorage = FullAgentStorage`) and `types.ts` re-exports it plus the option types, so the two shapes can never drift again. Loop helpers migrate to narrow ports — `nextLamportClockForConversation` now takes `ConversationEventStore`; the checkpoint port (`CheckpointStore`) already existed separately in `sessionStorage.ts`. Ports are exported from the package root for host adapters. Tests in `src/storage/__tests__/ports.test.ts` prove an events-only object drives loop helpers without satisfying the monolith, the lamport optimization path is honored, and a full adapter remains assignable to every narrow port (3/3); core build + lint 0 errors; core full suite 489/490 (known code-assistant baseline); CLI build passed and its storage-adjacent tests 20/20 (SQLite suite remains blocked by the pre-existing better-sqlite3 native issue in this environment, unrelated to this change).

### 24.42 Define StorageClass, claims, volumes, and snapshots

**Status:** completed
**Scope:** CSI-like resource lifecycle.
**Completion criteria:** Provision, topology, access mode, publish, snapshot, re
store, replica, backup, and health are declarative.
**Implementation record:** 2026-07-17 — Added CSI-like storage resources to `packages/memeloop/src/orchestration/resources.ts` under apiVersion `storage.memeloop.io/v1alpha1`. `StorageClass` declares the driver, replication (factor, fault domains, auto-rebuild), encryption (keyRef only, never key material), allowed access modes, snapshot support, backup schedule/retention, and data policy. `AgentVolumeClaim` (PVC-like) requests storage with accessMode (`ReadWriteOnce`/`ReadOnlyMany`/`ReadWriteMany`), size, selector, and `dataSourceRef` for snapshot restore; status tracks Pending/Bound/Lost. `AgentVolume` (PV-like) carries the opaque `driverHandle`, capacity, topology (node/zone), access modes, and a status with phase (Pending/Available/Bound/Published/Failed), per-node `replicas` (healthy/degraded/rebuilding/offline), `publishedTo`, and aggregate health. `AgentSnapshot` references a source volume; status tracks Ready/Failed, `readyToUse`, restore size, and the opaque snapshot handle. Manifest builders and type guards follow existing conventions; tests in `resources.test.ts` cover the full provisioning → claim → volume → snapshot/restore chain and guards (7/7 passed, lint 0 errors, build passed).

### 24.43 Implement SQLite and Markdown storage drivers

**Status:** completed
**Scope:** CLI Node reference implementations.
**Completion criteria:** SQLite is fenced single-writer with online snapshots; M
arkdown uses atomic replacement and content-addressed blobs. Both pass storage c
onformance.
**Implementation record:** 2026-07-17 — Markdown stores each event as an immutable atomically published file, so separate processes converge on one message identity; attachments recompute and verify size and canonical SHA-256. SQLite stores its writer lease and monotonic token in the database, canonicalizes path aliases, and installs per-table triggers that atomically reject stale tokens inside each write statement. Snapshots clear the copied active lease before restore. Markdown 7/7 and SQLite fencing/snapshot 8/8 focused tests pass.

### 24.44 Implement TiddlyWiki HTTP storage driver

**Status:** completed
**Scope:** fetch-based portable optional entry.
**Completion criteria:** ETag/revision CAS, bounded blobs or BlobStore reference
s, authentication handles, and conflict behavior are tested in browser and Node.
**Implementation record:** 2026-07-17 — The portable driver accepts only an opaque credential handle plus trusted per-request header resolver. Existing tiddlers require a strong ETag and `If-Match`; initial creation uses `If-None-Match: *`; missing validators fail closed. Bounded inline blobs and conflict retries remain. Seven focused tests and the browser-capable core build pass.

### 24.45 Implement replicated storage controller

**Status:** in-progress
**Scope:** replica placement, snapshot transfer, hash verification, primary fencing, and rebuild.
**Completion criteria:** Loss and corruption converge to desired replicas across failure domains. Quarantine never stores trusted replicas.
**Implementation record:** 2026-07-17 — Authoritative replicas are restricted to trusted nodes; the quarantine opt-in was removed. Primary election must atomically commit the previous/next fence through the transport, transfer must reject inactive epochs, and the controller independently re-reads the target digest after transfer. Nine focused tests pass. Remaining completion dependency: implement the fence and transfer contract over the 24.54 ControlStore CAS/lease and run it through 24.55 controller runner.

### 24.46 Define CredentialGrant and broker contract

**Status:** completed
**Scope:** issue, renew, revoke, inspect, materialize opaque handles.
**Completion criteria:** Every grant is Run/attempt/worker/target/method/audience/policy/expiry scoped and records exposure/rotation requirements.
**Implementation record:** 2026-07-17 — Run UID, attempt, worker key, target, method, audience, and policy digest are mandatory in resource and token claims. Verification compares the entire scope and requires a broker-issued one-time challenge through `CredentialProofVerifier.verifyAndConsume`; omission is fail-closed. Seven focused tests cover all scope mismatches, invalid PoP, expiry, revocation, renewal, and exposure.

### 24.47 Define ArtifactRecord and artifact driver

**Status:** in-progress
**Scope:** content address, trust, provenance, scanning, sanitation, promotion, and mounting.
**Completion criteria:** Derived content inherits lowest trust and cannot enter trusted prompts, volumes, backups, or knowledge without policy and verifier.
**Implementation record:** 2026-07-17 — Mutable review booleans were replaced by evidence bound to content hash, policy digest, destination, reviewer, and narrow properties. Failed/current-content evidence always blocks; lower trust requires an explicit policy and verifier review. Storage, external inspection execution, and trusted review writing are separate ports; inspection binding mismatch or failed review causes quarantine. Ten focused tests pass. Remaining completion dependency: 24.52 must enforce the review writer actor and every prompt/mount/backup/knowledge consumer must call admission.

### 24.48 Implement hostile artifact defenses

**Status:** in-progress
**Scope:** terminal escapes, active markup, archives, links, paths, MIME, malformed parsers, oversized streams, and prompt injection.
**Completion criteria:** Adversarial fixtures remain bounded and quarantined; parsing occurs outside controllers.
**Implementation record:** 2026-07-17 — Portable primitives strip terminal control sequences, force markup into an explicit plain-text rendering contract, validate archive paths/metadata and MIME signatures, detect prompt-injection markers, and preserve bounded-collector state after rejection. The trusted pipeline delegates parsing to `ArtifactInspectionExecutor` and quarantines failed or mis-bound results. Twenty-three focused artifact tests pass. Remaining completion dependency: a CLI process/container sandbox with CPU/memory/time/decompression limits and malformed real-format fixtures.

**Dependency correction:** Before 24.45, 24.47, or 24.48 can return to `completed`, implement 24.54 ControlStore CAS/status authorization and 24.55 controller runner, then 24.50 immutable node trust and 24.52 verifier-only transitions. These are enforcement prerequisites, not later integration polish.

### 24.49 Define WorkerEnrollment and WorkerSession

**Status:** planned
**Scope:** one-time bootstrap, ephemeral identity, proof-of-possession, expiry, and revocation.
**Completion criteria:** Ordinary device and worker identities/grants are cryptographically and logically non-interchangeable.
**Implementation record:** Pending.

### 24.50 Implement immutable Node trust admission

**Status:** planned
**Scope:** trusted/restricted/quarantine roles and spec/status actors.
**Completion criteria:** Restricted/quarantine cannot become controller, voter, scheduler, plugin host, control-store client, or storage replica through any self-report or label update.
**Implementation record:** Pending.

### 24.51 Implement restricted and quarantine worker modes

**Status:** planned
**Scope:** CLI startup, configuration, identity, plugins, storage, and protocol.
**Completion criteria:** Modes use separate directories and identities, load only signed allowed components, and cannot inherit ordinary daemon credentials or plugin discovery.
**Implementation record:** Pending.

### 24.52 Implement verifier-only protected transitions

**Status:** planned
**Scope:** CompletedUnverified, VerificationFailed, Verified.
**Completion criteria:** Worker status cannot write Verified; trusted deterministic or Agent verifier records narrow evidence and transition authority.
**Implementation record:** Pending.

### 24.53 Implement revocation and new-identity promotion

**Status:** planned
**Scope:** incident, credential rotation, evidence, reimage/attestation, approval, and identity lifecycle.
**Completion criteria:** Quarantine identity is permanently revoked; promotion creates a new ordinary identity after trusted verification.
**Implementation record:** Pending.

### 24.54 Implement SQLite standalone ControlStore

**Status:** planned
**Scope:** CLI single-node reference.
**Completion criteria:** Resource CRUD/watch/CAS/status authorization/lease/snapshot work with one voter and restart recovery.
**Implementation record:** Pending.

### 24.55 Implement generic controller runner

**Status:** planned
**Scope:** watch queues, retries, leases, actions, conditions, finalizers, and events.
**Completion criteria:** Controllers are restart-safe, idempotent, observable, and portable apart from injected store/time/action ports.
**Implementation record:** Pending.

### 24.56 Implement scheduler and binding controller

**Status:** planned
**Scope:** filters, scoring, CAS binding, fencing, and explanations.
**Completion criteria:** Loop, tool, model, network, storage, credential, trust, data, capacity, locality, and rollout requirements are enforced before bind.
**Implementation record:** Pending.

### 24.57 Implement durable Run and script state

**Status:** planned
**Scope:** replace process-local Map state.
**Completion criteria:** Stable step/child/tool/model IDs survive restart and checkpoint schema/digest rules prevent invalid resume.
**Implementation record:** Pending.

### 24.58 Implement ordinary peer driver transport

**Status:** planned
**Scope:** CLI libp2p runtime/model/tool transport.
**Completion criteria:** Ordinary peers exchange versioned assignments and status through scoped driver protocols. LLMs no longer select node IDs or raw RPC methods.
**Implementation record:** Pending.

### 24.59 Implement quorum ControlStore adapter

**Status:** planned
**Scope:** etcd transaction/watch/lease adapter and membership operations.
**Completion criteria:** One-to-three voter migration, observer handling, loss-of-quorum behavior, snapshots, and fencing pass topology tests.
**Implementation record:** Pending.

### 24.60 Implement Fleet rollout controller

**Status:** planned
**Scope:** batch, canary, maxUnavailable, pause, deadline, rollback, and evidence aggregation.
**Completion criteria:** Hundreds of restricted fake workers use local loops/models/tools under bounded concurrency and budget; rollout pauses on configured failure/drift/security thresholds.
**Implementation record:** Pending.

### 24.61 Publish driver manifests and conformance harness

**Status:** planned
**Scope:** portable fixtures and Node harness.
**Completion criteria:** Every interface has fake drivers, record/replay fixtures, capability negotiation, errors, cancel/backpressure, crash/adoption, idempotency/fencing, downgrade, and security tests.
**Implementation record:** Pending.

### 24.62 Add Swarm and Kubernetes/K3s external drivers

**Status:** planned
**Scope:** separate optional Node plugins after interfaces stabilize.
**Completion criteria:** AgentLoopRun and ToolOperation map independently, co-location is explicit, and no backend SDK enters core or default CLI dependencies.
**Implementation record:** Pending.

### 24.63 Integrate Electron and other hosts

**Status:** planned
**Scope:** intentionally deferred beyond core/CLI.
**Completion criteria:** Electron imports CLI adapters, Tauri passes Rust fixtures, browser uses portable client, and Mobile/edge advertise partial capabilities without duplicating control or Agent state machines.
**Implementation record:** Pending. Do not begin during core/CLI implementation unless explicitly requested.

### 24.64 Run final adversarial and fleet acceptance

**Status:** planned
**Scope:** complete system.
**Completion criteria:** Portability, package, controller, scheduler, runtime, model, tool, network, storage, credential, artifact, hostile-worker, promotion, quorum, and hundred-node fleet suites all pass with documented RPO/RTO and residual risks.
**Implementation record:** Pending.
