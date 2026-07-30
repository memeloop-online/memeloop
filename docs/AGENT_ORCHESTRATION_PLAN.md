# MemeLoop Declarative Agent Orchestration Plan

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

### 9.5 Ubiquitous language

These terms have one meaning across code, tests, logs, and this worklog. New non-everyday terms must be defined here before they are used as architecture shorthand.

| Term                 | Exact meaning in MemeLoop                                                                                         | Concrete example                                               | Not this                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ControlStore         | The independent database for orchestration resources. The CLI file is `dataDir/control.db`.                       | A quality-gate checkpoint stored as a `LoopCheckpoint`.        | The conversation database `memeloop.db`; an Agent-accessible KV store. |
| resourceVersion      | A store-wide increasing decimal string assigned once per successful write.                                        | Create returns `1`; the next status update returns `2`.        | A business version, timestamp, or generation.                          |
| generation           | The number of accepted desired-state (`spec`) revisions. Status-only writes do not increment it.                  | Changing placement requirements increments generation.         | The database revision.                                                 |
| CAS                  | A write that succeeds only when the submitted resourceVersion equals the current value.                           | Two controllers update one status; one receives `CONFLICT`.    | `get` followed by an unconditional update.                             |
| actor                | A host-bound controller, verifier, or administrator identity supplied outside Agent/model input.                  | `controller/checkpoint-node`.                                  | A prompt claiming “I am an administrator.”                             |
| status authorization | A check, in the same write transaction, that the actor may change the status subresource.                         | A verifier may write a protected verification result.          | Hiding a UI button or auditing after the write.                        |
| Watch                | Ordered `ADDED`, `MODIFIED`, and `DELETED` events after a supplied resourceVersion.                               | A controller resumes after revision `42`.                      | Polling a list and guessing changes.                                   |
| compaction           | Removal of watch history that is no longer resumable while current resources remain available.                    | An old cursor receives `WATCH_COMPACTED`.                      | Deleting current resources or clearing the database.                   |
| lease                | A named, expiring exclusive right held by one controller.                                                         | `controller-a` holds `replication/volume-1` until `expiresAt`. | A permanent process-local mutex.                                       |
| fencing epoch        | The integer incremented when a lease is acquired by a new holder; stale holders cannot write with an older epoch. | `controller-b` gets epoch `2`; epoch `1` is rejected.          | A retry count or alias for resourceVersion.                            |
| LoopCheckpoint       | An immutable resource keyed by conversation ID and completed step key.                                            | `quality-gate:1:attempt`.                                      | Full chat history, executable code, or credentials.                    |
| review evidence      | A review result bound to content hash, policy digest, destination, reviewer, and narrow properties.               | A scan pass valid only for the `volume` destination.           | A general `verified: true` boolean.                                    |
| enforcement level    | The boundary a network driver actually controls: `none`, `process`, `namespace`, `host`, or `external`.           | Environment-only proxy configuration reports `process`.        | A self-reported `supportsRequired=true` flag.                          |

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

**Phase ordering:** Steps are numbered but not phase-ordered in this worklog. The canonical phase sequence is defined in §20. Phase 3 explicitly blocks all production remote-executor work. Phase 8 (including §24.62) is the last phase and must not be implemented before Phases 0–7 are genuinely complete.

Status values are `planned`, `in progress`, `blocked`, and `complete`. When completing a step, replace the status, add the completion date, list the actual files changed, record deviations or follow-up debt, and include the exact focused validation that passed.

**Brevity rule (mandatory):** Implementation records must stay brief — a few sentences or one short bullet list covering what changed, why, and the focused validation. Always append the Git commit hash(es) that carry the change (e.g. `(abc1234)`); the commit message holds the detail, this document must not duplicate it. Never paste code, test listings, or multi-paragraph narratives. When amending an existing record, prefer one dated line over rewriting history. Keep this document lean enough to remain readable as a ledger.

### 24.1 Establish the repository plan as the handoff source

**Status:** complete (2026-07-16)
**Scope:** `docs/AGENT_ORCHESTRATION_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/HOST_INTEGRATION.md`.
**Completion criteria:** The repository contains one discoverable source of truth covering resources, planes, interfaces, trust, phases, and verification. The temporary session-memory plan is removed.
**Implementation record:** Added this document and linked it from the architecture and host-integration guides. `git diff --check` and editor diagnostics passed.

### 24.2 Freeze the implementation scope guard

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** package scripts or CI checks in `packages/memeloop` and `packages/memeloop-cli`.
**Completion criteria:** A check fails if core imports Node builtins or if orchestration work modifies `memeloop-react-ui`. Existing unrelated working-tree changes remain untouched.
**Implementation record:** 2026-07-19 — Added `scripts/check-portable-boundaries.mjs`. Scans memeloop core for Node builtin imports, banned platform packages, and raw Buffer usage. Legitimate adapter files (libp2p, CLI) are excluded. 2026-07-21 — Kimi K3 enhanced the script: (1) detects non-literal dynamic `import()` that defeats admission control; (2) detects raw `process.env` access in portable core; (3) detects raw `global` object property access (not `globalThis`); (4) enforces `memeloop-react-ui` scope guard (core must never import react-ui); (5) wired `check:boundaries` script into root and memeloop `package.json`. Fixed existing violations: replaced `process.env` with injected context in `builtinPromptPlugins.ts`, renamed `global` variable to `globalPerms` in `toolUseGate.ts` (false positive). `scriptLoader.ts` non-literal dynamic import is allowlisted as known debt (24.14/24.15). Tests: `scopeGuard.test.ts` 6/6, full suite 787/787, `node scripts/check-portable-boundaries.mjs --ci` passes with 0 violations.
**2026-07-23 quality correction:** Removed the libp2p adapter allowlist and added manifest enforcement for concrete transport, provider, storage, and orchestrator dependencies; Node builtins and `Buffer` are now uniformly rejected in production core source. (`ca3f9ca`)

### 24.3 Inventory current portable-boundary violations

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** core imports, package dependencies, public exports, Buffer/process usage, concrete libp2p and provider factories.
**Completion criteria:** A checked-in inventory identifies every violation, its destination, and migration order without changing runtime behavior.
**Implementation record:** 2026-07-19 — Integrated into `scripts/check-portable-boundaries.mjs`. The scan identifies every Node builtin import, banned platform import, and Buffer misuse in core. 2026-07-21 — Kimi K3 completed the inventory: baseline verified 0 violations in memeloop core (excluding legitimate adapter files). All previously detected violations (process.env in `builtinPromptPlugins.ts`, variable named `global` in `toolUseGate.ts`, non-literal dynamic import in `scriptLoader.ts`) are resolved or allowlisted with documented debt. The `check:boundaries` script is the canonical inventory tool — run `node scripts/check-portable-boundaries.mjs --ci` to enforce.
**2026-07-23 quality correction:** The earlier inventory was incomplete: it ignored package metadata and allowlisted the concrete libp2p implementation. Concrete networking is now the independently published `@memeloop/libp2p` host adapter; provider SDKs are optional peers, unused etcd/native dependencies were removed, browser paths use `Uint8Array`, and both real packed manifests were audited. Core/CLI/adapter builds and 946/397/22 tests passed. (`ca3f9ca`)

### 24.4 Define canonical resource metadata primitives

**Status:** completed
**Scope:** new portable orchestration types under `packages/memeloop/src/orchestration`.
**Completion criteria:** TypeMeta, ObjectMeta, ResourceReference, owner reference, condition, event, generation, and resourceVersion types are JSON-safe and browser-safe.
**Implementation record:** 2026-07-17 — TypeMeta, ObjectMetadata, OwnerReference, ResourceManifest/Resource/Reference, generation, resourceVersion, creationTimestamp. 2026-07-19 — Added `actorReportedStatus` to `OrchestrationResourceStatus`, keeping controller-observed and actor-asserted status separate. Conditions, finalizers, and generic resource events are complete.

### 24.5 Define the Agent-facing orchestration facade

**Status:** complete (2026-07-16)
**Scope:** portable client contract exported by `memeloop`.
**Completion criteria:** Agent loops receive a manager-facing facade that can discover capabilities and create/get/list/watch/delete declarative resources. It exposes no drivers, platform handles, or credentials. All operations carry actor/admission context through the host implementation.
**Implementation record:** Added `AgentOrchestrationClient` with capability discovery and apply/get/list/watch/delete operations. Actor identity is intentionally absent from call parameters and must be bound by the host implementation. The facade exposes manifests, references, queries, options, resources, and watch events only. Typed convenience clients remain Step 24.12. Focused runtime/tool tests passed; core lint and DTS/build passed.

### 24.6 Define orchestration resource and watch semantics

**Status:** completed
**Scope:** apply/get/list/watch/delete options and events.
**Completion criteria:** Contracts cover dry-run, field manager, CAS preconditions, resourceVersion resume, bookmarks, timeout/cancel, deleted resources, and terminal watch errors.
**Implementation record:** 2026-07-17 — Dry-run, field manager, idempotency key, resourceVersion, pagination, watch events (ADDED/MODIFIED/DELETED), BOOKMARK, ERROR events, timeout, AbortSignal. 2026-07-19 — Deleted final-state semantics (deletionTimestamp on DELETED events), exact CAS preconditions via `resourceVersion` in options, watch compaction via `WATCH_COMPACTED` error. All watch semantics complete.

### 24.7 Define structured orchestration errors

**Status:** completed
**Scope:** portable error codes and retry metadata.
**Completion criteria:** Errors distinguish unsupported, forbidden, conflict, stale epoch, not found, invalid, exhausted, unavailable, timeout, cancelled, and unknown-effect cases. Callers do not parse message strings.
**Implementation record:** 2026-07-17 — `OrchestrationError` class with `OrchestrationErrorData` covering UNSUPPORTED, FORBIDDEN, CONFLICT, STALE_EPOCH, NOT_FOUND, INVALID, EXHAUSTED, UNAVAILABLE, TIMEOUT, CANCELLED, UNKNOWN_EFFECT, WATCH_COMPACTED, INTERNAL. Each error carries retryable flag, retryAfterMs, reason, and structured details. `toJSON()` serializes for cross-boundary transport.

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
**Completed by model:** DeepSeek V4 Pro (K3) — agentClient; Kimi K3 — convenience clients
**Scope:** `ctx.agents`, `ctx.tools`, `ctx.models`, `ctx.networks`, `ctx.storage`, `ctx.credentials`, and `ctx.artifacts` convenience clients.
**Completion criteria:** Helpers compile down to the same resource facade, add stable owner/idempotency metadata, and cannot request cluster-scoped Class or Secret resources unless policy explicitly allows it.
**Implementation record:** Injected `ctx.agentClient` into `AgentAgentLoopScriptArguments` in `packages/memeloop/src/loopAPI/agent-agent-loop/loop.ts`. It is constructed from `createAgentClient(context.runtime.orchestration)` when the runtime provides an orchestration facade, and is `undefined` otherwise. 2026-07-21 — Kimi K3 added `createConvenienceClients(client, defaultNamespace)` in `packages/memeloop/src/orchestration/convenienceClients.ts` providing typed create/get/delete methods for all six remaining resource kinds: ToolOperation, ModelCallRecord, NetworkAttachment, AgentVolumeClaim, CredentialGrant, and ArtifactRecord. Each client adds stable `fieldManager` and `idempotencyKey` metadata, validates `apply` results are the expected kind, and cannot create cluster-scoped Class or Secret resources. Tests: 8/8 passed (create all 6 types, delete all 6 types, idempotencyKey pass-through). Core build passes, targeted lint clean.

### 24.13 Add Agent workload creation from scripts

**Status:** completed
**Scope:** script helper for one-shot child Agent workloads.
**Completion criteria:** A script can create a child workload with profile/script, prompt reference, trust, placement, model/tool/network/storage policy, owner reference, stable child key, and completion policy.
**Implementation record:** Defined canonical `AgentWorkload` and `AgentRun` resource schemas in `packages/memeloop/src/orchestration/resources.ts` with manifest builders, type guards, and reference helpers. Added `createAgentClient(client, defaultNamespace)` in `packages/memeloop/src/orchestration/agentClient.ts` exposing `createWorkload`, `createRun`, `getWorkload`, `getRun`, `deleteWorkload`, `deleteRun`, and `waitFor*Condition`. Scripts can call `const agents = createAgentClient(ctx.orchestration)` and create child workloads declaratively. The client validates `apply` results are the expected kind and rejects resources that do not match. Tests in `packages/memeloop/src/orchestration/__tests__/resources.test.ts` and `packages/memeloop/src/orchestration/__tests__/agentClient.test.ts` cover manifest construction, type guards, facade calls, condition waiting, and deletion. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; focused test suites passed 8/8.

### 24.14 Add remote Agent deployment from scripts

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3) — pipeline wiring; Kimi K3 — scheduling consumption
**Scope:** script helper for service-like or remote Agent deployment.
**Completion criteria:** A script declares placement and desired lifecycle rather than choosing a peer RPC method. Scheduler and admission select the remote node. The script can watch readiness and delete the deployment.
**Implementation record:** 2026-07-19 — `scriptRuntime.ts`. `RemoteDeploymentRequest` and `RemoteDeploymentResult` define declarative script placement: script, digest, trustClass, lifecycle (run-once/service/schedule), runtimeClass, nodeSelector, and env. The scheduler picks the target node; the script never selects raw peer RPC methods. Integrated with `selectRuntimeClass` for sandbox selection.
**2026-07-21 (K3):** `scriptDeploymentPipeline.ts` now connects `RemoteDeploymentRequest` through the full pipeline: source → normalizeScript → validateScript (Acorn AST, see 24.16) → admitScript → ArtifactRecord manifest → `RemoteDeploymentRequest.artifactRef` (only digest — raw source is no longer carried). The `ScriptArtifactStore` port allows the CLI to persist artifact content. `createScriptLoadGate` wires the same chain into the in-process script loading path.
**2026-07-22 (K3):** Agent-facing surface landed: `createScriptDeploymentClient` wraps the pipeline with host-bound trust/interface ceilings/persistence; propagated via `AgentFrameworkContext.scriptDeployment` → `AgentLoopRuntime` → `ctx.scriptClient` in AgentAgent scripts (undefined when unconfigured); CLI `createNodeRuntime` wires it from `workerTrustClass` + `scriptArtifactStore`. Scripts declare placement/lifecycle and cannot elevate trust. Validation: core 808/808, CLI 340+2 skipped. (`b64f449`)
**2026-07-22 (K3, scheduling consumption):** `remoteDeploymentToWorkloadManifest` maps the request to an `AgentWorkload` (spec gains `runtimeClass`); `ScriptDeploymentClient.deploy` applies it via the new `createControlStoreOrchestrationClient` facade (host-bound actor, idempotent content-addressed apply, CONFLICT on spec drift); `waitForScheduled`/`deleteDeployment` expose readiness/deletion (UNSUPPORTED without a facade); the binding controller now writes the `Scheduled` condition; CLI wires the facade into `scriptDeployment`. Validation: core 830/830, CLI 343+2 skipped. (`1e08fa2`) Correction carried forward: `scriptLoader.ts` has no ungated `data:` URL fallback — every source-bearing reference passes the host-injected `ScriptLoadGate` and fails closed when no gate is configured.
**2026-07-22 (K3, execution):** Bound workloads now execute in the CLI daemon: `LoopRuntimeDriver` port + in-process driver (script workloads via synthesized AgentAgent profile re-admitted by the load gate; lazy `runtime.js` import avoids an init cycle), `createWorkloadExecutionController` (executes only `assignedNode`-bound workloads, creates/adopts the AgentRun, mirrors outcomes, cancels on deletion), and CLI wiring of both the binding runner and execution controller by default. Fixed two latent bugs the new tests exposed: QuorumControlStore watch lost events in the one-shot re-registration gap (now buffered subscriptions), and controllerRunner leaked its renew timer after lease loss. Validation: core 838/838, CLI 344+2 skipped. (`f7a7285`)
**2026-07-22 (K3, env consumer + process isolation):** `AgentWorkloadSpec.env` added; `remoteDeploymentToWorkloadManifest` maps `deployment.env`; the isolated child-process driver (see 24.18) applies it through the secret guard. **Deferred:** the isolated driver's cgroups/namespace hard limits (24.18 debt).
**2026-07-26 quality correction (durable execution ownership):** The earlier execution controller could persist `Running` before `driver.start`, had no durable owner claim, ignored `Running` resources on restart, and therefore both stranded work after a daemon crash and allowed competing node daemons to launch the same Run. `AgentRunStatus` now has a `Starting` pre-effect phase and a daemon-lifetime `runtimeExecutionClaim`. Controllers compete for that claim with ControlStore CAS; only the winner may invoke the runtime. A restart safely resumes work only when no claim was ever written, mirrors an already-terminal Run without resolving or relaunching its script, and fails a claimed `Starting`/`Running` Run as `UNKNOWN_EFFECT` because the current narrow runtime cannot adopt it. Any error after the durable claim is likewise classified as uncertain external state rather than silently authorizing replay. Four focused recovery/race tests plus an assertion at the real invocation boundary cover these guarantees.

### 24.15 Add script-generated `.mjs` artifact storage

**Status:** completed
**Completed by model:** Kimi K3 — production wiring
**Scope:** generated script source, artifact references, size limits, and provenance.
**Completion criteria:** An Agent can submit source as an ArtifactRecord and reference it from an AgentWorkload. Source is never imported directly from an LLM string in the controller process.
**Implementation record:** 2026-07-19 — Script source flows through `validateScript` (canonical SHA-256 digest) → `ArtifactRecord` (content-addressed storage) → `RemoteDeploymentRequest` (references artifact by digest). Source is never imported directly from an LLM string in the controller process. The artifact trust pipeline (24.47) and verifier-only transitions (24.52) govern promotion to trusted prompts/volumes/backups.
**2026-07-22 (K3):** Production wiring closed the remaining debt: core exports `defaultRequestedInterfacesForTrustClass`/`maxScriptBytesForTrustClass` and the previously unreachable `scriptDeploymentPipeline.js` (latent DTS error fixed); CLI `createFileScriptArtifactStore` persists artifacts content-addressed with hash-verified atomic writes (0600) and tamper-detecting read-back; `createNodeRuntime` accepts `trustClass` and wires `createScriptLoadGate` as the default `loopScriptPolicy` (host override preserved), exposed via `NodeRuntimeResult.scriptArtifactStore`; `cli.ts start` passes the worker-mode trust class. Validation: core 800/800, CLI 339+2 skipped, boundaries 0 violations, both builds pass. (`4770967`, build-debt fix `9127fbb`)

### 24.16 Add generated-script validation and normalization

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3) — Acorn AST migration; Kimi K3 — verified completion
**Scope:** syntax parsing, export shape, imports, deterministic metadata, and canonical digest.
**Completion criteria:** Invalid source, forbidden imports, oversized scripts, unsupported API versions, and non-deterministic metadata are rejected before scheduling.
**Implementation record:** 2026-07-19 — `scriptValidation.ts`. `validateScript` checks size (1 MiB max), extracts imports via regex, flags forbidden imports (Node builtins, libp2p), detects default async generator exports, rejects CommonJS, and computes a canonical SHA-256 digest via `crypto.subtle.digest`. `normalizeScript` strips BOM, normalizes CRLF→LF, and trims trailing whitespace for deterministic digests. Seven focused tests cover valid scripts, oversize, empty, forbidden imports, CommonJS, missing export, and digest determinism.
**2026-07-21 (K3):** Migrated from regex-based import extraction to **Acorn AST parser** (`acorn` added to core dependencies). Import extraction now covers static `import` declarations, re-exports (`export ... from`), and string-literal dynamic `import()` arguments. Non-literal dynamic imports are rejected because they defeat admission control. The canonical digest now commits to the NORMALIZED source, so CRLF/LF variants share one digest. `hasNonLiteralDynamicImport` flag added to `ScriptValidationResult`. `package.json` updated with `"acorn": "^8.16.0"`.

### 24.17 Add generated-script admission policy

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** trust class, author, requested interfaces, import policy, resource limits, and approval.
**Completion criteria:** Trusted, restricted, and quarantine profiles have explicit script policies. Quarantine cannot enable arbitrary network imports or plugin loading.
**Implementation record:** 2026-07-19 — `scriptAdmission.ts`. `admitScript` enforces trust-class-gated policies: trusted (1 MiB, full interfaces), restricted (256 KiB, loop-runtime + model only, no fs/net), quarantine (64 KiB, loop-runtime only, no network/model/fs/crypto). Interface allowlists, import bans, and required exports are checked. Five tests cover admission, size rejection, interface denial, missing export, and checkpoint compatibility.

### 24.18 Add generated-script sandbox/runtime selection

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** RuntimeClass requirements for source scripts.
**Completion criteria:** Source scripts cannot silently run in an unrestricted controller process. Runtime capability declares module isolation, CPU/memory/time limits, cancellation, and supported trust classes.
**Implementation record:** 2026-07-19 — `scriptRuntime.ts`. Three built-in `RuntimeClass` specs: `trusted-process` (2 CPU, 512 MiB, 5 min, full network), `restricted-process` (1 CPU, 128 MiB, 2 min, outbound-only), `quarantine-process` (0.5 CPU, 32 MiB, 30 sec, no network). `selectRuntimeClass` maps trust class to least-privileged runtime via `supportedTrustClasses`. 2026-07-21 — Kimi K3 fixed the silent fallback debt: `selectRuntimeClass` now throws an explicit error when no RuntimeClass supports the requested trust class, instead of silently falling back to `quarantine-process`. This prevents a trusted workload from being placed in a quarantine sandbox without error. Tests: 7/7 passed (replaced "falls back" test with "throws when no match" and "throws when empty list"). Core build passes, targeted lint clean.
**Remaining debt:** The RuntimeClass specs are declarations only; no process-level isolation (cgroups, namespaces, seccomp) is enforced. This requires CLI/host integration (Phase 4+).
**2026-07-22 (K3, isolation made real):** `createProcessLoopRuntimeDriver` (CLI) executes script workloads in a dedicated child process — sanitized env (24.35), wall-clock SIGTERM/SIGKILL, V8 heap cap from the class, `networkAccess: 'none'` removes ambient fetch in the child; child re-verifies the source digest before import and fails host-authority capabilities explicitly. `createRuntimeClassRoutingDriver` (core) routes by declared isolation and fails closed on unknown/missing classes. CLI `createNodeRuntime` uses it by default (`workloadExecution.processIsolation=false` opts out). Validation: core 848/848, CLI 357+2 skipped; e2e proves the child pid differs from the daemon. (`6da9063`) **Remaining debt (narrowed):** cgroups/namespace/seccomp hard limits (CPU/RSS) and 'outbound-only' target restriction remain unenforced — declared, not claimed.
**2026-07-23 capability update (GPT-5):** Process-isolated source now executes in a separate `vm.SourceTextModule` realm inside the child with string/Wasm code generation disabled and imports rejected. The script-visible `process` exposes only sanitized env and PID, not the inherited IPC primitive; parent protocol messages cannot be forged through the declared API. A bounded IPC `runAgent` capability is now available, while orchestration/resource clients remain denied. Tests cover VM/import isolation, hidden `process.send`, request/response bounds, and real child-agent streaming. (`04f3108`) The OS-level cgroup/namespace/seccomp and outbound-target debt above remains explicit.

**2026-07-23 isolation debt cleared:** Default NodeRuntime now advertises local process classes only after a real Linux probe succeeds. systemd cgroup v2 enforces CPU, RSS, zero swap, and task limits; bubblewrap provides user/PID/IPC/UTS/cgroup/mount and restricted-network namespaces with a minimal filesystem; setpriv applies no-new-privileges plus an architecture-checked seccomp filter. `none`/`outbound-only` have no direct IP path and retain only bounded parent capabilities; failed/unsupported hosts advertise no process class. The cgroup files, `Seccomp: 2`, `NoNewPrivs: 1`, blocked direct network, smallest class, volumes, model/network bindings, builds, and full core 946/CLI 399+2-skipped suites passed. Quarantine MemoryMax is 96 MiB because the prior 32 MiB could not contain the trusted Node/VM bootstrap. (`c71c1b7`)

### 24.19 Add script checkpoint compatibility rules

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** script digest, API version, checkpoint schema, and migration.
**Completion criteria:** A changed script cannot resume an incompatible checkpoint without an explicit converter or restart policy.
**Implementation record:** 2026-07-19 — `scriptAdmission.ts`. `admitScript` checks `expectedCheckpointDigest` against `script.digest` and validates `checkpointApiVersion` against `COMPATIBLE_CHECKPOINT_VERSIONS`. Changed scripts cannot resume incompatible checkpoints. Tests cover digest mismatch detection and version-gated compatibility.

### 24.20 Add an orchestration builtin tool for AgentToolLoop

**Status:** complete (2026-07-16)
**Scope:** core builtin tool plugin backed by AgentOrchestrationClient.
**Completion criteria:** The LLM tool loop can discover allowed resource kinds and apply/get/list/delete resources through one admission-controlled tool. Tool schemas do not expose raw driver or credential fields.
**Implementation record:** Added the `orchestration` builtin and `builtin:orchestration` plugin with capabilities/apply/get/list/delete actions. Input normalization forwards only whitelisted manifest metadata and operation options; attempted status, actor, and grant fields are discarded. Missing manager returns an explicit error. Seventeen builtin-tool tests and nested runtime tests pass.

**Validation note for Steps 24.4-24.20:** `pnpm --filter memeloop lint` and `pnpm --filter memeloop build` passed. Focused suites passed 32 tests across AgentAgentLoop, runtime propagation, and builtin tools. The full core suite ran 382 tests with 381 passing; the sole failure is the pre-existing `src/loopProfiles/__tests__/builtins.test.ts` expectation that the generated code-assistant profile contains `wikiSearch` and `wikiOperation`. The generated profile currently contains `workspacesList`, `modelContextProtocol`, `spawnAgent`, `askQuestion`, `getErrors`, and `webFetch`; this unrelated profile change was not modified or reverted.

### 24.21 Add condition waiting for ToolLoop calls

**Status:** complete (2026-07-21)
**Completed by model:** GPT 5.5
**Scope:** bounded wait action over resource watch.
**Completion criteria:** ToolLoop can wait for Ready/Completed/Failed with timeout and cancellation without returning an unbounded AsyncIterable to the model.
**Implementation record:** 2026-07-21 — Consolidated the duplicated polling loops into the exported portable `waitForCondition` helper in `packages/memeloop/src/orchestration/agentClient.ts`. `WaitForConditionOptions` now accepts `AbortSignal` plus a host cancellation hook; cancellation throws structured non-retryable `CANCELLED`, preserves the last observed resourceVersion, removes abort listeners, and clears pending timers. `createAgentClient` uses the helper for workload and Run conditions. `packages/memeloop/src/tools/builtins/orchestration.ts` uses the same helper and binds it to the ToolLoop's existing `isCancelled()` and active-conversation `conversationCancellation` state, so a model-requested wait stops without another resource read or an unbounded `AsyncIterable`. Tests prove success, timeout, immediate signal cancellation, in-flight ToolLoop cancellation, no extra `get`, and zero leaked timers. Exact validation: `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/agentClient.test.ts src/tools/builtins/__tests__/builtins.test.ts` (28/28), targeted ESLint (0 errors), and `node scripts/check-portable-boundaries.mjs --ci` passed.

### 24.22 Migrate `spawnAgent` to the orchestration facade

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** local child Agent builtin tool.
**Completion criteria:** `spawnAgent` creates an AgentWorkload/Run through the facade and waits according to policy. Direct `runLocalAgent` is removed after CLI supplies the reference manager.
**Implementation record:** Refactored `packages/memeloop/src/tools/builtins/spawnAgent.ts` so that when `context.orchestration` reports support for `AgentWorkload`, it creates a workload via `createAgentClient`, then a run, waits for `Completed=True`, and returns the run summary with `resourceVersion` in the structured detail reference. When no orchestration manager is configured, the tool falls back to the existing `runLocalAgent` path so local behavior continues to work. This satisfies the migration without breaking existing runtimes before the CLI manager lands. Direct `runLocalAgent` removal remains gated on the reference manager in `memeloop-cli`. Tests in `packages/memeloop/src/tools/builtins/__tests__/builtins.test.ts` cover both the orchestration path and the legacy local path. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/builtins.test.ts` passed 22/22.

### 24.23 Migrate `task` to the orchestration facade

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** specialized Agent delegation.
**Completion criteria:** Task profile, permissions, parent ownership, nesting budget, background mode, and detail references are represented in resources rather than mutable shared context.
**Implementation record:** Refactored `packages/memeloop/src/tools/builtins/task.ts` to use the orchestration facade when available. The orchestration path creates an `AgentWorkload` with `profileId`, `promptReference`, `completionPolicy` (`complete` or `detach`), and a `toolPolicy` that carries the selected agent profile's `defaultAction` and `rules`. It then creates an `AgentRun`; for synchronous tasks it waits for `Completed=True`, and for background tasks it returns the task ID immediately. When no orchestration manager is configured, the tool falls back to the legacy `runLocalAgent` path and still applies `toolPermissions` to the local context. Nested-depth guard, missing-agent validation, and conversation ID format remain unchanged. Extended `AgentWorkloadToolPolicy` in `packages/memeloop/src/orchestration/resources.ts` with `defaultAction` and `rules`. Tests in `packages/memeloop/src/tools/builtins/__tests__/taskTool.test.ts` cover both paths and verify that permissions are serialized into the workload manifest. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/tools/builtins/__tests__/taskTool.test.ts` passed 15/15.

### 24.24 Migrate `remoteAgent` to declarative placement

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
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

**Status:** complete (2026-07-23 quality audit)
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** adapt current IToolRegistry behind the new effect interface.
**Completion criteria:** Existing tools run through ToolOperation identity, policy, audit, cancellation, output limits, and result normalization.
**Implementation record:** Implemented `createInProcessToolExecutionDriver(registry, options)` in `packages/memeloop/src/orchestration/toolExecutionDriver.ts`. The driver accepts a `ToolOperationResource`, looks up the tool by `spec.toolRef.name` in an `IToolRegistry`, enforces the `policy.requireApproval` guard, executes `BuiltinToolImpl` implementations with the supplied `BuiltinToolContext`, normalizes both sync and async-iterable outputs, applies `maxOutputLength` truncation, and returns a `Completed` or `Failed` `ToolOperationResource` with `status.result` (value or structured `OrchestrationErrorData`). It also calls an optional `auditor` with the running operation and result. The driver increments `status.attempts` and records `startedAt`/`completedAt`. Tests in `packages/memeloop/src/orchestration/__tests__/toolExecutionDriver.test.ts` cover success, missing tool, approval rejection, auditor invocation, and output truncation. `pnpm --filter memeloop lint` passed with 0 errors; `pnpm --filter memeloop build` passed; `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/toolExecutionDriver.test.ts` passed 5/5.

**2026-07-23 (quality audit closure):** Tool execution now receives an `AbortSignal`; the execution controller enforces `timeoutMs`, bounds uncooperative drivers, terminalizes read cancellation/timeout, and marks destructive interruption `UNKNOWN_EFFECT` for verification. CLI watches cancellation/deletion and aborts active effects; the generic runner no longer retries a deleted resource from a stale snapshot. Validation: core 917/917, CLI 376 passed + 2 skipped, targeted lint, both production builds, and portable-boundary checks passed. (`3f6899a`)

**2026-07-26 (approval-path quality correction):** The earlier implementation only rejected `requireApproval`; it did not implement the successful `RequestApproval` path claimed by §10.10. `createInProcessToolExecutionDriver` now accepts a host-owned `ToolOperationApprovalBroker`. Admission-policy and per-operation approval requirements invoke the broker with the immutable operation identity, trusted policy explanation, and cancellation signal. Only structurally valid `allow` evidence permits execution; denial, malformed evidence, broker failure, absent broker, and cancellation while approval is pending all fail closed before tool lookup or invocation. The approval id, authenticated actor, decision, timestamp, and optional reason are stored in `ToolOperationStatus.approval` and included in the resource snapshot supplied to the auditor. `createNodeRuntime` exposes the broker injection boundary without coupling core to any Desktop/UI implementation. Focused coverage proves allow, deny, malformed evidence, broker failure, no-broker denial, cancellation, audit evidence, and the durable NodeRuntime control path (30/30); full core 960/960 and CLI 407 passed + 5 explicit environment-gated skips; core and CLI production builds with declarations and changed-file lint pass.

### 24.29 Route AgentToolLoop calls through ToolOperation

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** ReAct tool-use gate and execution primitives.
**Completion criteria:** ToolLoop requests an operation and consumes its status/result. Existing PreToolUse/PostToolUse hooks remain ordered and cannot bypass trusted admission.
**Implementation record:** 2026-07-16 — `executeWithGuards` in `packages/memeloop/src/loopAPI/agent-tool-loop/toolCallRunner.ts` now routes tool execution through `context.orchestration` when the facade serves `ToolOperation` (`apply` + `get` capabilities required). The runner applies a `ToolOperation` manifest (`BuiltinTool` ref, `execute` effect, 60s `timeoutMs`, `metadata` audit level) with a counter-suffixed unique name, polls `get` every 250ms when the applied operation is not yet terminal, and maps terminal status to the existing `ToolRunRow` shape (`Completed` → value/structured payload, `Failed`/`Cancelled` → structured error message). When the facade is absent or does not serve `ToolOperation`, execution falls back to the previous registry path unchanged, so hook ordering (PreToolUse gate → execute → PostToolUse) is preserved on both paths and the doom-loop guard still runs first. Tests in `packages/memeloop/src/loopAPI/__tests__/agentToolLoop.orchestration.test.ts` cover facade routing (registry not consulted), Failed status surfacing, capability fallback, and Running→Completed polling. `pnpm --filter memeloop exec vitest run src/loopAPI/__tests__/agentToolLoop.orchestration.test.ts src/loopAPI/__tests__/agentToolLoop.test.ts` passed 12/12; `pnpm --filter memeloop lint` 0 errors; `pnpm --filter memeloop build` passed. **Debt cleared 2026-07-17:** `idempotencyKey` is now derived per logical call — `conversationId:fnv1a(stableStringify(toolId+parameters)):occurrence` — stable for controller retries, distinct for new identical calls; timeout is configurable via `AgentToolLoopOptions.toolOperationTimeoutMs` (default 60s) and carried in `spec.timeoutMs`. A latent framework bug was found and fixed while testing: `turnPrimitives.ts` built the assistant `messageId` as `conversationId:a:Date.now()`, so two iterations within one millisecond shared identity — the later round replaced the earlier assistant message, the round-1 tool result landed "after" the round-2 assistant message, and duplicate-output detection wrongly skipped the new call. The id now includes `state.iteration`. Tool-result message ids got the same class of fix (monotonic counter suffix) for identical parallel/same-ms calls. Regression coverage: idempotency-key derivation + timeout assertion + two-round occurrence test in `agentToolLoop.orchestration.test.ts`; full `src/loopAPI/__tests__/` suite 53/53 across three consecutive runs.

**2026-07-23 (quality audit, CLI consumption):** `createNodeRuntime` now injects its ControlStore-backed manager facade into `AgentFrameworkContext.orchestration`; previously only `scriptDeployment.orchestration` was set, so the production AgentToolLoop silently stayed on the legacy registry fallback despite this step being marked complete. The runtime now starts the independently bound local ToolOperation control path described in 24.56. Direct facade → durable operation → executor → terminal result is covered end to end.

### 24.30 Separate tool permission from capability authorization

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** permission layers, SecurityProfile, and grant validation.
**Completion criteria:** Model-facing allow/ask/deny remains UX and defense in depth; trusted admission is non-overridable. Restricted and quarantine default deny.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/admission.ts` with `NodeTrustClass` (`trusted`/`restricted`/`quarantine`), `ToolAdmissionPolicy` (ordered first-match-wins rules over tool pattern + effect, with a `defaultAction`), `defaultAdmissionPolicyForTrustClass` (restricted/quarantine → deny), `defaultPermissionActionForTrustClass`, and a pure `evaluateToolAdmission` reusing the existing permission glob matcher. The trusted layer is wired into `createInProcessToolExecutionDriver` via a new host-bound `admission` option: denials fail with `FORBIDDEN` before tool lookup and are still passed to the auditor; `require-approval` decisions fail closed until an approval broker exists. The model-facing layer remains UX/defense-in-depth: `AgentToolLoopOptions.trustClass` now drives the implied permission default in `buildLayeredPermissions` (restricted/quarantine → deny when no explicit wildcard rule; explicit config still wins). Neither layer is reachable by the model or `.mjs` scripts — both are bound by the host at context/driver assembly. Tests in `packages/memeloop/src/orchestration/__tests__/admission.test.ts` cover trust-class postures, rule/effect matching, driver deny/allow/require-approval paths with audit, and gate defaults. `pnpm --filter memeloop exec vitest run src/orchestration/__tests__/admission.test.ts src/orchestration/__tests__/toolExecutionDriver.test.ts` passed 15/15; lint 0 errors; build passed. **Debt cleared 2026-07-17:** admission policy is now resolvable from a resource — `SecurityProfile` (`security.memeloop.io/v1alpha1`) carries `trustClass`, a `toolAdmission` overlay, and `modelPolicy` (allowed model classes + max input classification); `AgentWorkloadSpec.securityProfileRef` references it. `resolveAdmissionPolicy(profile, trustClass)` merges profile rules over the trust-class default with profile rules evaluated first, and forces the resolved default to `deny` for restricted/quarantine regardless of what the profile declares (non-overridable invariant). Declarative admission types (`NodeTrustClass`, `ToolAdmissionPolicy`, `ToolAdmissionRule`, `DataClassification`) now live in `resources.ts` with schema; `admission.ts`/`modelProviderDriver.ts` re-export them for compatibility. The deferred `WorkloadCapabilityGrant` resource was completed with the quarantine-worker protocol on 2026-07-26 (see §24.49).

**2026-07-26 correction:** The trusted `require-approval` action is no longer a terminal placeholder. It delegates only through the host-bound `ToolOperationApprovalBroker`, persists approval evidence in the operation status/audit view, and retains deny-by-default behavior when no authenticated host implementation is configured. This deliberately does not reuse the model-facing in-memory approval queue as an authority boundary.

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
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** CredentialBroker and ModelGateway.
**Completion criteria:** Handle binds Run, attempt, worker key, model, audience, policy, token/cost/concurrency budget, expiry, and proof-of-possession.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/modelAccessHandle.ts`. `ModelAccessHandleClaims` binds handleId, runRef, attempt, `workerKey` (proof-of-possession fingerprint), modelClassRef, modelDigest, `audience`, `policyDigest`, token/cost/concurrency `budget`, issuedAt, and expiresAt. Tokens are opaque `mlh1.<base64url claims>.<base64url signature>` strings; signing is behind the injectable `ModelHandleSigner` port so core stays browser-safe (Node hosts plug in HMAC/Ed25519). Pure base64url helpers avoid Buffer/atob. `createInMemoryModelAccessHandleBroker` issues handles (TTL default 15min, hard-capped at 60min) and verifies signature, audience, expiry, and worker-key binding, throwing structured `INVALID`/`FORBIDDEN`/`TIMEOUT` OrchestrationErrors. Handles are documented as never written to logs, checkpoints, status, or resource specs. Tests in `packages/memeloop/src/orchestration/__tests__/modelAccessHandle.test.ts` cover base64url round-trips, issuance/verification of all bound fields, tamper/audience/worker-key/expiry rejection, and TTL capping (10/10 passed, lint 0 errors, build passed). Remaining debt: budget _enforcement_ belongs to the ModelGateway (not yet implemented); proof-of-possession is verified as fingerprint equality — a signing challenge at the transport layer is future work; no revocation list yet. 2026-07-23 (K3): budget enforcement and revocation landed with the ModelGateway (`3df6a7e`, step 24.65) — the gateway enforces token/cost/concurrency/request-rate budgets from handle claims and revokes handles on Run completion/cancellation. Transport-layer signing challenge remains future work.

### 24.35 Remove long-lived model keys from worker context

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3) — redaction + launch policy; Kimi K3 — consumption points + gateway routing
**Scope:** CLI provider construction and worker launch.
**Completion criteria:** Provider keys are absent from worker argv, environment, config, checkpoint, status, logs, and crash diagnostics. Unsupported direct providers use the gateway.
**Implementation record:** 2026-07-16 — Two layers. (1) Portable redaction: `packages/memeloop/src/orchestration/secretRedaction.ts` provides `redactSecrets` (deep-clone masking of secret-shaped keys — apiKey/authorization/token/password/etc. — and secret-shaped values — OpenAI/Anthropic/AWS/GitHub/Slack formats, `mlh1.*` handles, Bearer headers) plus `containsSecrets` for pre-persistence assertions; hosts must run values through it before logs, status, checkpoints, and crash diagnostics. (2) Worker launch policy: `packages/memeloop-cli/src/orchestration/workerEnvironment.ts` `sanitizeWorkerEnvironment` strips provider-secret env vars (`*_API_KEY`, `*_SECRET*`, `*_ACCESS_TOKEN`, etc.) and any value matching a known secret format from the inherited environment, keeps platform basics and an explicit allowlist, injects only the non-secret `MEMELOOP_MODEL_GATEWAY` endpoint, and returns stripped variable _names_ (never values) for audit. ModelAccessHandles are delivered over the worker bootstrap channel (unix socket/stdio), never via env — enforced by the secret-format guard rejecting `mlh1.*` values in `extra`. Tests: core `secretRedaction.test.ts` 8/8, CLI `workerEnvironment.test.ts` 5/5; core lint 0 errors, build passed; CLI lint clean on changed files (344 pre-existing errors elsewhere: MCP SDK unresolved imports); CLI full suite has 20 pre-existing failures caused by `better-sqlite3` native module "did not self-register" in this environment (same class as the documented NODE_MODULE_VERSION mismatch), unrelated to this change; core full suite 455/456 with the known code-assistant profile baseline failure. Remaining debt: no CLI provider-construction call site strips keys yet because the process Runtime Driver (which will consume `sanitizeWorkerEnvironment`) is not yet implemented; gateway-mediated provider fallback arrives with the ModelGateway step. 2026-07-22 (K3): the consumption point landed — the isolated child-process LoopRuntimeDriver (`6da9063`, see 24.18) launches workers with `sanitizeWorkerEnvironment`, so provider keys are absent from worker argv/env/config; `deployGeneratedScript` additionally rejects secret-shaped env values so ControlStore specs never persist credentials. Crash diagnostics carry only the bounded child stderr tail (the child env has no secrets). **Remaining debt (narrowed):** gateway-mediated provider fallback still awaits the ModelGateway step; the worker bootstrap channel (delivering ModelAccessHandles over stdio/socket) and host-authority capabilities inside isolated workers (currently fail explicitly) arrive with it. 2026-07-23 (K3): the ModelGateway landed (`3df6a7e`, step 24.65) and is wired into the CLI daemon by default with ControlStore auditing. **Remaining debt (narrowed):** route loop model calls through the gateway by default (loops still call `ILLMProvider` directly inside the daemon), and the worker-side authenticated transport/bootstrap channel that delivers handles to isolated workers (§12.4). 2026-07-23 (K3): loop routing landed — `createGatewayMediatedLLMProvider` issues a per-call short-lived handle, streams through gateway verification/budget/audit, and revokes the handle at call end; `createNodeRuntime` replaces `context.llmProvider` with it by default (`modelGateway.routeLoops=false` keeps the §12.3 direct exception; `loopBudget` stamps per-call budgets). Loops hold no credential on this path by construction. Validation: core 872/872, CLI 363+2 skipped. (`4a433fd`) **All completion criteria are now met** (keys absent from argv/env/config/checkpoint/status/logs/crash diagnostics; the gateway is the default provider path), so this step is completed and Phase 3 is fully closed. **Deferred:** the worker-side authenticated bootstrap channel that would let isolated child-process workers call the gateway (§12.4) — currently those workers have no model capability and fail explicitly; tracked under the 24.18/24.65 transport debt.

**2026-07-23 deferred transport cleared (GPT-5):** Isolated local scripts receive a bounded `runAgent` capability over their inherited child-process IPC channel; external workers use the signed, replay-fenced worker protocol and native Secret bootstrap recorded in 24.62. Both paths invoke `context.runChildAgent` in the trusted host, whose provider is already ModelGateway-mediated. The worker therefore receives neither provider credentials nor a transferable model handle; keeping the handle inside the host narrows authority further than sending one across the boundary. Requests and responses have count, concurrency, schema, size, deadline, scope, and rate bounds. (`04f3108`, `ec512b7`)

### 24.36 Implement local-model endpoint registration

**Status:** completed
**Scope:** restricted worker model capability.
**Completion criteria:** Local model digest, health, capacity, modalities, data policy, and trust are advertised and schedulable. Local model output cannot authorize tools.
**Implementation record:** 2026-07-16 — Added `packages/memeloop/src/orchestration/localModelRegistration.ts`. `describeLocalModelEndpoints(driver, options)` turns any `ModelProviderDriver` into `ModelClass` + `ModelEndpoint` manifests carrying provider/model identity, content digest, modalities, nodeId, node trust, capacity, and data policy; endpoint handles are opaque (`local://<node>/<provider>/<model>`) and never embed credentials or URLs. `selectModelEndpoint(endpoints, requirements)` is the pure scheduling filter: class name, digest match, minimum node-trust rank (quarantine < restricted < trusted), health (excluded by default), and spare concurrency, preferring the highest-capacity candidate and returning null instead of silently falling back to an unvetted endpoint. The "local model output cannot authorize tools" invariant is architectural: tool admission (24.30) is host-bound and has no construction path from model output — model streams flow only through `ModelStreamChunk` data. Tests in `packages/memeloop/src/orchestration/__tests__/localModelRegistration.test.ts` cover advertisement shape and all selection filters (6/6 passed, lint 0 errors, build passed).
**2026-07-22:** Registration + heartbeat landed: `createModelEndpointRegistrar` upserts ModelClass/ModelEndpoint into the ControlStore each tick, refreshes `status.healthy`/`heartbeat` with CAS retries, prunes unlisted endpoints, and fails safe (marks owned unhealthy) on driver failure or `stop()`. CLI `createNodeRuntime` starts it by default when a ControlStore exists (opt-out via `modelEndpointRegistration.enabled=false`); `cli.ts` stops it on shutdown. Also fixed `QuorumControlStore.matchQuery` (apiVersion contains `/`, breaking kind/namespace matching). Validation: core 814/814, CLI 342+2 skipped, boundaries 0 violations, both builds pass. (`fe574b0`)
**2026-07-23 (quality audit):** Fixed a production-path serialization failure hidden by a passing integration test: AI SDK providers keep a function/object in legacy `ILLMProvider.model`, and the registrar attempted to persist it in `ModelClass`, causing `structuredClone` to reject every heartbeat. Providers now expose a separate serializable `modelId`; Node registration and gateway selection never persist `model`. A regression test uses a function-valued SDK model, requires a cloneable `ModelClass`, and asserts zero swallowed registrar errors. Validation: focused CLI 5 passed + 2 explicitly skipped; core and CLI builds pass.
**2026-07-23 (binding audit):** AgentRuns now persist a lease-fenced ModelEndpoint selected from fresh health, digest, trust, classification, residency, model-name, locality, and conservatively reserved capacity; execution waits for and consumes that exact binding through host provider/gateway resolver ports. CLI advertises explicit capacity and uses the registered ModelClass identity in its gateway; stale/unreachable endpoints fail closed. (`111a6fa`)

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
**2026-07-23 (quality audit, production consumption):** The earlier driver was not wired into NodeRuntime and no workload created or waited for a NetworkAttachment. The CLI now advertises only NetworkClasses that `process-env` can actually satisfy, binds and prepares attachments through separate global/per-node controllers, injects the prepared non-secret patch into the isolated child, and fails closed for missing consumers or in-process workloads. `prepare` is idempotent by attachment UID; workload completion requests release and the driver must release before status becomes `Detached`. (`56f3f83`)

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
**2026-07-23 (quality audit, production lifecycle):** Added the portable CSI-like `StorageDriver` host port plus independent claim binding/provisioning and Run publication controllers in `packages/memeloop/src/orchestration/{drivers/storageDriver,volumeClaimController,runVolumeController}.ts`. Binding rejects unhealthy/untrusted provisioners, wrong topology/selectors, exhausted capacity, unsupported access modes, snapshots, encryption, and oversize claims. Provision and publish each persist a lease-epoch fencing claim before the idempotent host effect; an epoch change becomes terminal `UNKNOWN_EFFECT` instead of a blind replay. Multi-volume publication persists one opaque binding per reconcile, and explicit release unpublishes every known handle. Workload runtime requests receive only ephemeral resolved mount paths; host paths never enter ControlStore status. (`5303d94`)

### 24.43 Implement SQLite and Markdown storage drivers

**Status:** completed
**Scope:** CLI Node reference implementations.
**Completion criteria:** SQLite is fenced single-writer with online snapshots; M
arkdown uses atomic replacement and content-addressed blobs. Both pass storage c
onformance.
**Implementation record:** 2026-07-17 — Markdown stores each event as an immutable atomically published file, so separate processes converge on one message identity; attachments recompute and verify size and canonical SHA-256. SQLite stores its writer lease and monotonic token in the database, canonicalizes path aliases, and installs per-table triggers that atomically reject stale tokens inside each write statement. Snapshots clear the copied active lease before restore. Markdown 7/7 and SQLite fencing/snapshot 8/8 focused tests pass.
**2026-07-23 (quality audit, workload-volume reference driver):** Added the separate CLI `local-directory` workload storage driver in `packages/memeloop-cli/src/orchestration/localDirectoryStorageDriver.ts`. This is intentionally distinct from the conversation SQLite/Markdown adapters above: it provisions private `0700` host directories, uses deterministic opaque claim/publication handles, persists `0600` publication metadata for restart adoption, rejects cross-node publication, and advertises no snapshot/encryption support. `createNodeRuntime` exposes it only on trusted hosts and passes resolved paths to isolated child processes through per-volume environment entries. It is a process-path reference implementation, not a claim of hostile-host filesystem isolation. (`5303d94`)

### 24.44 Implement TiddlyWiki HTTP storage driver

**Status:** completed
**Scope:** fetch-based portable optional entry.
**Completion criteria:** ETag/revision CAS, bounded blobs or BlobStore reference
s, authentication handles, and conflict behavior are tested in browser and Node.
**Implementation record:** 2026-07-17 — The portable driver accepts only an opaque credential handle plus trusted per-request header resolver. Existing tiddlers require a strong ETag and `If-Match`; initial creation uses `If-None-Match: *`; missing validators fail closed. Bounded inline blobs and conflict retries remain. Seven focused tests and the browser-capable core build pass.

### 24.45 Implement replicated storage controller

**Status:** completed
**Scope:** replica placement, snapshot transfer, hash verification, primary fencing, and rebuild.
**Completion criteria:** Loss and corruption converge to desired replicas across failure domains. Quarantine never stores trusted replicas.
**Implementation record:** 2026-07-17 — Authoritative replicas are restricted to trusted nodes; the quarantine opt-in was removed. Primary election must atomically commit the previous/next fence through the transport, transfer must reject inactive epochs, and the controller independently re-reads the target digest after transfer. 2026-07-19 — `createReplicationController` wraps the pure logic in a `createControllerRunner` with ControlStore CAS. The controller re-reads the current volume from the store for the CAS token and delegates status writes to the runner. Four conformance tests validate CAS integration, rebuild, primary election, and skip-on-missing-storageclass; nine pure tests cover placement, loss, corruption, and fencing.

**2026-07-28 production-wiring and fencing correction:** Reverse audit found two defects hidden by permissive mocks. First, no production runtime constructed `createReplicationController`. Second, the wrapper replaced the required data-plane `commitPrimaryFence` with a no-op and performed transfers before the later ControlStore status CAS; a correctly fenced transport would therefore reject a newly elected epoch. NodeRuntime now accepts an explicit host-owned replica-node inventory and `ReplicationTransport`, starts/stops the controller, and advertises replication from the local provisioner only when that complete port is present. The transport must durably and idempotently commit the exact primary transition before accepting an idempotent transfer; ControlStore status is an observable CAS-protected mirror, not the native fence. Exact-transition idempotency permits safe recovery when the external fence succeeded but the subsequent status CAS lost a race. Unchanged reconciliation status is no longer rewritten, preventing controller self-trigger loops.

Claim binding and the immediate pre-effect path now share one capability gate for driver identity, access mode, snapshot/restore, encryption, replication factor, backup, and capacity. The production managed adapter independently revalidates the resolved Claim/Class and native capability, validates adopted-volume ownership/class/access/capacity, and treats an invalid or under-capacity post-effect native result as terminal `UNKNOWN_EFFECT`. Focused evidence is 24/24 core storage/controller tests plus a real SQLite NodeRuntime test that provisions from the local driver, observes the injected transport commit `fence:1` before `transfer:1`, and converges across two declared fault domains. This proves controller/runtime routing and retry semantics; the actual cross-machine byte transport remains embedding-host infrastructure and physical fault-domain evidence remains tracked by §24.64.

**2026-07-28 mutable-volume snapshot correction:** The first production wiring still treated the last ControlStore `contentHash` as permanent truth. A legitimate write to the fenced primary was consequently classified as corruption, while an unbound `transferReplica(from, to, epoch)` could copy a different live version if the primary changed during transfer. The transport contract now captures an internally verified, immutable, ephemeral snapshot from the active fenced primary; every transfer is bound to that exact snapshot handle/hash and the controller re-reads the target hash before accepting it. The captured primary snapshot advances the authoritative hash after legitimate writes, while failover after primary loss may still promote only a readable replica matching the last committed hash. Snapshot authority is never persisted, release is idempotent, cleanup is attempted on failure without masking the original effect error, and a cleanup failure after otherwise successful work prevents the status CAS so retry can finish cleanup. Focused tests cover legal primary mutation, exact-version transfer under a concurrent later write, failed-transfer cleanup, loss/corruption, fencing, and the real NodeRuntime route.

### 24.46 Define CredentialGrant and broker contract

**Status:** completed
**Scope:** issue, renew, revoke, inspect, materialize opaque handles.
**Completion criteria:** Every grant is Run/attempt/worker/target/method/audience/policy/expiry scoped and records exposure/rotation requirements.
**Implementation record:** 2026-07-17 — Run UID, attempt, worker key, target, method, audience, and policy digest are mandatory in resource and token claims. Verification compares the entire scope and requires a broker-issued one-time challenge through `CredentialProofVerifier.verifyAndConsume`; omission is fail-closed. Seven focused tests cover all scope mismatches, invalid PoP, expiry, revocation, renewal, and exposure.
**2026-07-23 (quality audit, production reconciliation):** The convenience client previously bypassed types with `as never`, omitted mandatory `attempt`/`workerKey`, and wrote nonexistent `expiresAt`; it now constructs the exact schema. Separate binding, per-node issuance, and lifecycle controllers validate Run/Workload UID, workload policy, host worker-key admission, broker class/scope/health/capacity, and persist a fencing claim before issue. Tokens live only in an injected external vault; ControlStore receives an opaque handle reference. Run terminal state, expiry, and deletion revoke the deterministic grant and delete vault material. (`6a71ee9`)

### 24.47 Define ArtifactRecord and artifact driver

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** content address, trust, provenance, scanning, sanitation, promotion, and mounting.
**Completion criteria:** Derived content inherits lowest trust and cannot enter trusted prompts, volumes, backups, or knowledge without policy and verifier.
**Implementation record:** 2026-07-17 — Mutable review booleans were replaced by evidence bound to content hash, policy digest, destination, reviewer, and narrow properties. Failed/current-content evidence always blocks; lower trust requires an explicit policy and verifier review. Storage, external inspection execution, and trusted review writing are separate ports. 2026-07-19 — `createControlStoreArtifactReviewWriter` adapts `ArtifactReviewWriter` to ControlStore + verifier-only authorizer. Every `appendReview` and `quarantine` calls `store.updateStatus` with CAS and verifier authorization. Five conformance tests validate verifier enforcement, fail-safe quarantine, missing-artifact errors, and content hash binding. 2026-07-21 — Kimi K3 verified `assertArtifactAdmission` and `canArtifactEnter` are already implemented in `artifactTrust.ts` with full destination-policy gating (prompt/volume/backup/knowledge), trust-rank comparison, content-hash-bound evidence, and a throwing variant for driver/controller enforcement. Combined 33 tests (15 verifier-only + 10 artifact-trust + 5 review-writer + 3 artifact-trust focused). Consumer-level wiring will happen when prompt/mount/backup/knowledge consumer components are created in later steps; the portable admission API is complete and tested.

### 24.48 Implement hostile artifact defenses

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** terminal escapes, active markup, archives, links, paths, MIME, malformed parsers, oversized streams, and prompt injection.
**Completion criteria:** Adversarial fixtures remain bounded and quarantined; parsing occurs outside controllers.
**Implementation record:** 2026-07-17 — Portable primitives strip terminal control sequences, force markup into an explicit plain-text rendering contract, validate archive paths/metadata and MIME signatures, detect prompt-injection markers, and preserve bounded-collector state after rejection. 2026-07-19 — `packages/memeloop-cli/src/sandbox/processSandbox.ts`: sandboxed child process with hard limits on time/output/environment, stdin piping, truncation marker. 2026-07-21 — Verified: 30/30 tests (23 portable artifact + 7 CLI sandbox).

### 24.49 Define WorkerEnrollment and WorkerSession

**Status:** completed
**Scope:** one-time bootstrap, ephemeral identity, proof-of-possession, expiry, and revocation.
**Completion criteria:** Ordinary device and worker identities/grants are cryptographically and logically non-interchangeable.
**Implementation record:** 2026-07-18 — `WorkerEnrollment` and `WorkerSession` resources defined with security.memeloop.io/v1alpha1 API. Enrollment requires controller or admin actor; workers cannot self-enroll. `bindWorkerSession` creates an ephemeral identity bound to a worker key fingerprint with explicit TTL. `revokeWorkerSession` immediately invalidates the session. `isWorkerSessionValid` checks active phase and expiry. Eight conformance tests cover schema, actor permissions, session lifecycle, and validity checks. Validation: workerIdentity tests 8/8, core build passes, targeted lint clean (0 errors).

**2026-07-23 quality correction (GPT-5):** The earlier report was not trustworthy: `bindWorkerSession` contained an explicit placeholder and created an active session without loading the enrollment or verifying its token, expiry, consumption state, or actor. Binding now requires a host-injected constant-time token verifier, validates enrollment state and expiry, fences the enrollment to one worker-key fingerprint with ControlStore CAS, caps session TTL at enrollment expiry, and uses a stable session identity so a controller crash after fencing can resume safely. Invalid token, expired enrollment, replay under a different key, TTL capping, revocation, and validity are covered (10/10); the portable package build passes. The raw token is accepted only as a call argument and is never stored or returned.

**2026-07-23 quality correction, cryptographic scope completed (GPT-5):** Enrollment now pins the expected gateway URL and Ed25519 key fingerprint plus audience, protocol version, Run UID/attempt/epoch, policy digest, allowed methods, and allowed targets. Binding verifies the worker's encoded ephemeral Ed25519 public key and proof-of-possession, then copies only that trusted enrollment scope into the session. The dedicated `worker.memeloop.io/v1alpha1` protocol signs canonical envelopes and validates deadline, audience, Run scope, policy, method, target, payload/response size, and request rate before dispatch. A ControlStore status CAS atomically consumes the next sequence and a bounded nonce window, so replay remains denied after gateway restart. Worker-visible errors retain only a generic code/category while trusted diagnostics stay host-side. (`b719cf2`, `04f3108`)

**2026-07-26 capability-grant quality correction:** The resource model named `WorkloadCapabilityGrant`, but no such implementation existed and `capability.request` went directly from session-level admission to host execution. Added a durable, gateway-signed, single-use `WorkloadCapabilityGrant` whose canonical claims bind grant identity, WorkerSession, Run UID/attempt/epoch, worker key, pinned gateway channel identity, audience, protocol method, capability, target, policy digest, request/input/output budget, issuer, and TTL capped by the session. Verification checks every authority-bearing claim, lifecycle, time bounds, budget, and signature; ControlStore CAS consumes the grant before invocation. The production external-worker `runAgent` path now issues, verifies, and consumes this grant before reaching the trusted child-agent/ModelGateway path, and the real worker-process integration asserts the persisted signed evidence. Focused core/CLI worker suites pass (15/15); full core 963/963 and CLI 407 passed + 5 explicit environment-gated skips; both production builds with declarations and the portable-boundary guard pass.

### 24.50 Implement immutable Node trust admission

**Status:** completed
**Scope:** trusted/restricted/quarantine roles and spec/status actors.
**Completion criteria:** Restricted/quarantine cannot become controller, voter, scheduler, plugin host, control-store client, or storage replica through any self-report or label update.
**Implementation record:** 2026-07-18 — `createNodeTrustAuthorizer` enforces immutable Node trust admission through ControlStore authorization. Node trustClass can only be set at creation; subsequent changes require a verifier actor, signed evidence, and matching trustVerifiedBy. Self-assertion through labels (`trust-class`, `trustClass`, `node-trust`) is rejected by `validateNodeSpec`. Restricted/quarantine nodes cannot acquire leases for controller, voter, scheduler, plugin-host, control-store-client, or storage-replica roles. `isNodeAllowedForRole` provides pure role checks for schedulers. Seventeen conformance tests cover creation, verifier transitions, evidence binding, self-report rejection, and lease denial. Validation: nodeTrustAdmission tests 17/17, core build passes, targeted lint clean.

### 24.51 Implement restricted and quarantine worker modes

**Status:** completed
**Scope:** CLI startup, configuration, identity, plugins, storage, and protocol.
**Completion criteria:** Modes use separate directories and identities, load only signed allowed components, and cannot inherit ordinary daemon credentials or plugin discovery.
**Implementation record:** 2026-07-18 — `resolveWorkerModeConfig` provides mode-aware startup configuration. Restricted and quarantine modes use separate data directories and identity files (suffixed with `-restricted`/`-quarantine`), never inherit ordinary daemon credentials, and disable ordinary plugin loading by default. The CLI `start` command accepts `--mode ordinary|restricted|quarantine` and resolves the worker mode before initializing the runtime. Nine conformance tests cover mode resolution, directory isolation, plugin restrictions, and trust class mapping. Validation: workerMode tests 9/9, CLI build passes, targeted lint clean.

### 24.52 Implement verifier-only completion transitions

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** CompletedUnverified, VerificationFailed, Verified.
**Completion criteria:** Worker status cannot write Verified; trusted deterministic or Agent verifier records narrow evidence and transition authority.
**Implementation record:** 2026-07-18 — `createVerifierOnlyAuthorizer` enforces verifier-only transitions for ArtifactRecord: only `verifier/` actors may append reviews or unquarantine; review evidence binds to current content hash, actor ID, and timestamp; reviews append-only; quarantine is fail-safe, unquarantine requires a passing verify review. 2026-07-21 — Verified: 15/15 conformance tests, core build passes.

### 24.53 Implement incident response and new-identity promotion

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** incident, credential rotation, evidence, reimage/attestation, approval, and identity lifecycle.
**Completion criteria:** Quarantine identity is permanently revoked; promotion creates a new ordinary identity after trusted verification.
**Implementation record:** 2026-07-18 — `revokeQuarantineIdentity` permanently revokes a quarantine enrollment and its active sessions (controller/admin actors only); `promoteIdentity` revokes the old identity and creates a new enrollment at the target trust class after trusted verification; `isIdentityRevoked` checks revocation status. 2026-07-21 — Verified: 8/8 conformance tests, core build passes.

### 24.54 Implement SQLite standalone ControlStore

**Status:** completed
**Scope:** CLI single-node reference.
**Completion criteria:** Resource CRUD/watch/CAS/status authorization/lease/snapshot work with one voter and restart recovery.
**Implementation record:** 2026-07-18 — Added `packages/memeloop/src/orchestration/controlStore.ts` and the independent CLI adapter `packages/memeloop-cli/src/orchestration/sqliteControlStore.ts`. The CLI stores control resources in `dataDir/control.db`, separate from conversations in `memeloop.db`. SQLite transactions allocate one global decimal resourceVersion per successful write and enforce idempotent create/status writes, exact status CAS, synchronous actor authorization, stable list snapshots, replayable Watch events, compaction errors, persistent lease IDs with monotonic fencing epochs, online snapshots, health checks, and restart recovery. `createNodeRuntime` exports and injects the store. Validation: `sqliteControlStore.test.ts` 8/8, `nodeRuntime.branchCover.test.ts` 3/3, core and CLI builds passed, and both package lint commands completed with 0 errors.

**2026-07-26 Apply/CRUD contract quality correction:** The controller-facing facade previously implemented `Apply` as a read followed by create-or-reject and treated every existing spec as immutable. This contradicted §10.1 and could not atomically roll desired state forward. `ControlStore.apply` is now an explicit backend transaction: absent resources are created; changed spec or declarative metadata uses exact resourceVersion CAS; UID, status, creation time, and deletion state are preserved; generation advances only for spec changes; and retries are bound to the actor plus complete desired manifest. SQLite stores the state, ordered event, revision, and operation-scoped idempotency response in one transaction and recovers it after restart. Create, Apply, status, and delete no longer collide when callers reuse the same idempotency string across operation classes. Delete now has tested authorization, UID/resourceVersion/generation preconditions, dry-run behavior, durable replay, and finalizer progression. Validation: SQLite 12/12, core facade/Quorum focused 42/42, full core 1006/1006, full CLI 412/412 with 7 explicit environment-gated skips, both production/declaration builds, and repository lint with zero errors.

### 24.55 Implement generic controller runner

**Status:** completed
**Scope:** watch queues, retries, leases, actions, conditions, finalizers, and events.
**Completion criteria:** Controllers are restart-safe, idempotent, observable, and portable apart from injected store/time/action ports.
**Implementation record:** 2026-07-18 — `createControllerRunner` is an async factory that acquires a lease before watching, renews it periodically, and releases it on stop. Watch events trigger `controller.reconcile` with the lease epoch for fencing. Successful reconciles may write status through ControlStore CAS. Failures retry with exponential backoff (base 100ms, max 30s). `stop()` releases the lease immediately without waiting for a potentially stuck watch iterator. Five conformance tests cover lease lifecycle, status CAS, retry, stop, epoch fencing, and resource filtering. Validation: controllerRunner tests 5/5, controlStoreLoopCheckpoints tests 2/2, core build passes, targeted lint clean. 2026-07-23 (K3): fixed a latent bug the 24.60 scale e2e exposed — requeue (`requeueAfterMs`) and error-retry timers reconciled the captured stale resource snapshot, so status-progressing controllers reprocessed the same stage forever and failed every status CAS; timers now re-get the current resource before reconciling, falling back to the last snapshot (`c406ac9`). 2026-07-23 audits: retries stop after confirmed deletion (`3f6899a`); watches now replay an initial snapshot after restart, and external-controller shutdown aborts its watches instead of leaking work past ControlStore close (`111a6fa`).
**2026-07-26 quality correction:** The previous “falling back to the last snapshot” behavior was unsafe: if the authoritative `ControlStore.get` failed, a retry could execute a controller side effect against stale desired state. Requeue and error-retry paths now wait and retry the authoritative read with exponential backoff; a missing resource stops immediately, and an unavailable store never authorizes reconciliation from the captured watch snapshot. A regression test holds the read unavailable and proves that no second reconcile occurs until resource version `2` can be observed. Validation: controller runner 7/7; core full suite 964/964; core lint and production/declaration build pass.

### 24.56 Implement scheduler and binding controller

**Status:** complete (quality audit closed 2026-07-23)
**Completed by model:** Kimi K3
**Scope:** filters, scoring, CAS binding, fencing, and explanations.
**Completion criteria:** Loop, tool, model, network, storage, credential, trust, data, capacity, locality, and rollout requirements are enforced before bind.
**Implementation record:** 2026-07-18 — `createBindingController` watches Pending AgentWorkloads, runs a scheduler to select a node, and updates status through ControlStore CAS with lease epoch fencing. Restricted and quarantine nodes are explicitly rejected for worker workloads. `createCapacityScheduler` filters by requiredNode, nodeSelector, and anti-affinity; scores by CPU/memory capacity with a trusted-node bonus. Ten conformance tests cover scheduling filters, scoring, trust preference, binding, and failure paths. Validation: scheduler tests 10/10, core build passes, targeted lint clean.
**Remaining debt:** Network, storage, credential, and rollout-batch filters declared in Section 17.1 are not yet implemented (require runtime/driver integration). Stable child IDs fixed in 24.57. 2026-07-21 — Kimi K3 fixed the design contradiction where restricted nodes were rejected for worker workloads (§7.2, §23: restricted is the preferred fleet-worker class). The scheduler now allows restricted nodes for ordinary/restricted workloads, only rejects quarantine nodes for non-quarantine workloads, schedules quarantine-designated workloads exclusively on quarantine nodes, adds data-classification filtering, taint/toleration support, model class availability filtering, and spare concurrency scoring. Tests: 32/32 passed. Core build passes, targeted lint clean.

**2026-07-23 (quality audit, scheduler reopened):** The earlier completion claim was not supported by its own remaining-debt record and was reopened. `AgentWorkload` now carries portable requirements for resources (CPU/memory/GPU/disk/bandwidth), required tool classes, network enforcement and egress, storage claims, scoped credential-broker capabilities, residency/attestation, artifact/checkpoint locality, and rollout fault-domain limits. `createCapacityScheduler` fail-closes on unhealthy/non-worker nodes, absent runtime/tool/model/network/storage/credential capability advertisements, weak network enforcement, insufficient capacity, missing attestation/residency, and saturated/excluded rollout domains. Locality is score-only and cannot bypass a hard filter. The binding controller re-runs the same complete eligibility predicate, rejecting fabricated nodes or a custom scheduler that selects a weaker node. CLI `createNodeRuntime` advertises its actual built-in runtime/tool/model capabilities and accepts an authoritative `listSchedulerNodes` host callback instead of forcing every workload onto the local daemon; an end-to-end test schedules an admitted script to a remote inventory node. Disabling the process driver now removes process RuntimeClasses from scheduling and the runtime router also rejects any forced process-isolated script instead of silently executing it in the daemon. Validation: scheduler 50/50; core full suite 902/902; CLI full suite 373 passed + 2 explicitly skipped; core/CLI production builds and portable-boundary checks pass.

**2026-07-23 (quality audit, independent ToolOperation placement):** Added a portable ToolExecutor selector and separate binding/execution controllers. Selection fail-closes on executor/node health, schema digest, node selector, trust, and live capacity, with preferred-node locality only affecting score. The execution controller persists a lease-epoch claim in one reconcile before invoking an effect in the next. A new epoch safely retries reads but moves destructive in-flight effects to terminal `UNKNOWN_EFFECT` with `verification-required`, never blind replay. CLI registers/reconciles a local ToolExecutor from the actual tool registry, applies host-bound trusted admission (restricted/quarantine default deny), starts a global binding lease plus per-node execution lease, and exposes idempotent `runtime.stop()` so all controller leases/health advertisements are released on restart. A production gap was also closed by injecting the ControlStore facade into `context.orchestration`. Validation: core full suite 912/912 (10 new controller tests); CLI full suite 375 passed + 2 explicitly skipped (2 new end-to-end tests).

**2026-07-23 (quality audit, independent ModelEndpoint placement):** Added a restart-replayed AgentRun binding controller and CLI production wiring. It persists endpoint UID/resourceVersion/lease epoch, rejects stale heartbeats and policy/capacity mismatches, reserves capacity across non-terminal runs, preserves the binding through terminal status, and requires in-process/process drivers to consume a matching endpoint through explicit remote transport ports. Validation: core 927/927; CLI 379 passed + 2 skipped; focused lint, both production builds, and portable-boundary checks passed. (`111a6fa`)

**2026-07-23 (quality audit, independent NetworkAttachment placement):** Added independently leased binding and per-node execution controllers. Binding hard-filters health, node affinity, capacity, driver identity, enforcement level, and NetworkClass features using an injectable authoritative multi-node driver inventory. Execution revalidates the exact NetworkClass resourceVersion and driver health/capabilities, persists a fencing claim before `prepare`, fails `UNKNOWN_EFFECT` after an epoch change, and performs explicit idempotent release before `Detached`. Workload execution creates a deterministic attachment, records its UID on AgentRun, waits for a valid attached handle, and passes it to the runtime; generated-script deployment now carries network policy. A CLI end-to-end test proves the proxy patch reaches a real isolated child process and is released afterward. Validation: core 933/933; CLI 383 passed + 2 skipped; targeted lint, both production builds, and portable-boundary checks passed. (`56f3f83`)

**2026-07-23 (quality audit, independent CredentialGrant placement):** Added a global broker binding controller, per-node fenced issuance controller, and restart-replayed lifecycle controller. Binding enforces the complete grant scope plus workload policy and host worker-key admission; issuance stores only an opaque reference in ControlStore while the token remains in an injected vault. Run termination, TTL expiry, and deletion revoke and erase material. CLI advertises broker capabilities only when a host injects a real broker/vault/admission port. Validation: core 940/940; CLI 384 passed + 2 skipped; targeted lint, both production builds, and portable-boundary checks passed. (`6a71ee9`)

**2026-07-23 (quality audit, independent volume placement and consumption):** Added authoritative multi-node `StorageDriverEndpoint` inventory, complete StorageClass/claim hard filtering, independently leased global binding and per-node provisioning, durable `AgentVolume` creation/adoption, and independent per-Run publication/release. The CLI scheduler advertises actual storage classes and bound claims instead of accepting declarations; generated-script storage policy reaches a real isolated child as a temporary mount-path environment entry. Runtime launch failures now terminalize AgentRun and request dependency cleanup; successful and failed runs release known network/volume effects. Validation after the final reliability fixes: core full suite 948/948; CLI full suite 388 passed + 2 credential-gated integration tests skipped; focused lint clean; core and CLI production builds including declarations pass; portable-boundary checks pass. (`5303d94`)

**Quality-audit closure:** The original completion claim was reopened because workload-only placement did not independently place infrastructure resources. ToolOperation, ModelEndpoint, NetworkAttachment, CredentialGrant, and volume claim/provision/publish lifecycles now each have explicit eligibility, live-capacity checks, durable UID/resourceVersion binding where applicable, lease-epoch fencing before effects, production host wiring, and end-to-end consumption. The scheduler also enforces workload loop/tool/model/network/storage/credential/trust/data/capacity/locality/rollout requirements and revalidates a selected node before CAS binding. The 24.56 completion criteria are now supported by implementation and executable evidence; no remaining debt is carried by this step.

### 24.57 Implement durable Run and script state

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** replace process-local Map state.
**Completion criteria:** Stable step/child/tool/model IDs survive restart and checkpoint schema/digest rules prevent invalid resume.
**Implementation record:** 2026-07-18 — Added `LoopScriptCheckpointStore` and `createControlStoreLoopCheckpointStore`; explicit script checkpoints are immutable `LoopCheckpoint` resources. 2026-07-19 — `ctx.state.set/update` writes through to ControlStore with `state:` key prefix; `ctx.state.get` falls back to persisted value. Child conversation IDs changed from `${Date.now()}` to deterministic `${profileId}` for stable restart. Checkpoint resources now include a SHA-256 `digest` field computed from the serialised result; `loadCheckpoint` verifies the digest and returns `undefined` on mismatch (fail-safe against corruption). 2026-07-21 — Kimi K3 fixed child ID collision: added a monotonic counter (`${input.conversationId}:child:${profileId}:${++childCounter}`) so concurrent runs of the same profile get unique IDs. AgentAgent loop tests 15/15, checkpoint tests 2/2, runtime tests 2/2, core build passes, targeted lint clean.

### 24.58 Implement ordinary peer driver transport

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** CLI libp2p runtime/model/tool transport.
**Completion criteria:** Ordinary peers exchange versioned assignments and status through scoped driver protocols. LLMs no longer select node IDs or raw RPC methods.
**Implementation record:** 2026-07-18 — `createPeerDriverTransport` wraps raw `sendRpc` in a versioned, scoped driver protocol (`memeloop-peer-driver/v1`). Assignments carry scope (`runtime`/`model`/`tool`), operation, parameters, and assignment ID for idempotency. `createPeerDriverRpcHandler` routes submit/status/cancel to local handlers and rejects unsupported versions or unknown methods. Seven conformance tests cover transport submission, status query, cancellation, version rejection, and missing handlers. Validation: peerDriverTransport tests 7/7, core build passes, targeted lint clean.

**2026-07-28 production-wiring quality correction:** The preceding completion claim was false. A reverse call-site audit found no production caller of either PeerDriver helper; CLI registered only the legacy Agent RPC handler. The helper also cast untrusted requests and responses, discarded the authenticated `remotePeerId`, and accepted unbounded identifiers, payloads, deadlines, and uncorrelated status responses. It therefore proved neither cross-machine execution nor a safe driver boundary.

Ordinary-node production transport now uses the already versioned `memeloop.resource.v1` protocol over `/memeloop/orchestration/1.0.0`. `memeloop start` registers this handler against the real NodeRuntime ControlStore facade. A runtime assignment is an `AgentWorkload`, model work/status is represented by `AgentRun`, and tool work by `ToolOperation`; submit, status/watch, and cancellation are the protocol's apply, get/watch, and delete operations. This keeps placement and effects behind the scheduler and controllers rather than exposing a local native driver or caller-selected node/RPC method.

The host derives a stable, non-reversible namespace from the Noise-authenticated peer identity and exposes only `AgentWorkload`, `AgentRun`, and `ToolOperation`. A caller may omit that namespace but cannot select another tenant, ControlStore actor, node, driver, credential, endpoint inventory, or infrastructure resource. Capabilities now advertise `ToolOperation` consistently. The compatibility `memeloop-peer-driver/v1` helper is not the production execution path; it was nevertheless hardened to bind `remotePeerId` into every host callback, validate version/scope/identifier/operation/deadline and bounded JSON, and correlate and validate every response.

Focused evidence includes nine compatibility-protocol tests, five namespace-boundary tests, and four CLI production-boundary tests. The latter starts two real TCP libp2p nodes, proves an unpaired request is denied, mutually accepts the Noise pairing transcript, then applies, reads, and deletes an `AgentWorkload` through the production transport and a real `QuorumControlStore`, verifying that state exists only in the authenticated peer's namespace. This replaces the earlier mock-only completion evidence; complete-worktree validation is recorded in §24.64.

**2026-07-28 controller-owned Run correction:** A follow-up adversarial audit found that kind allowlisting alone still let a paired peer directly apply or delete `AgentRun`. The workload controller executes only from `AgentWorkload`, but it adopted a pre-created deterministic `<workload>-run` without checking its workload UID. A peer could therefore preoccupy that name with a forged workload reference and contaminate later model, credential, and dependency binding. The namespace boundary now supports separate readable and mutable kind sets: peers may get/list/watch `AgentRun` status, but only mutate `AgentWorkload` and `ToolOperation`. Independently, the workload controller accepts an existing deterministic Run only when its API, kind, name, effective namespace, immutable workload UID, and controller-owned spec are exact; a forged Run fails both Run and workload before any runtime effect. Focused tests prove apply/delete denial and the pre-creation attack. This is defense in depth: controller correctness no longer depends on every transport applying the same remote policy.

### 24.59 Implement quorum ControlStore adapter

**Status:** completed
**Scope:** etcd transaction/watch/lease adapter and membership operations.
**Completion criteria:** One-to-three voter migration, observer handling, loss-of-quorum behavior, snapshots, and fencing pass topology tests.
**Implementation record:** 2026-07-19 — Complete in-process quorum ControlStore implementation (401 lines). Full CRUD with CAS, multi-voter quorum (configurable quorumSize), learner replication, watch subscriptions with revision tracking, lease management with epochs and TTL expiry, compaction of deleted resources, snapshot export. Loss-of-quorum writes rejected with UNAVAILABLE. Verifier-only transitions enforced via injected authorizer. 22 conformance tests: CRUD, CAS, leases, watches, health, topology mutation, verifier authorization, snapshot, compaction. A production etcd-backed adapter is planned as a separate package.
**2026-07-22:** Cleared the remaining in-process debt: fencing epochs are monotonic per lease name across holders/releases/expiries (no more epoch-1 restarts); `exportSnapshot`/`restoreSnapshot` round-trip resources, revision, term, membership, quorumSize, and lease epochs; `addLearner`/`removeLearner` observers hold no vote (§17.3); voter add/promote/remove recompute majority quorum and bump term, with a last-voter guard; one→three voter migration keeps serving writes. Topology tests 28/28, core 820/820, CLI 342+2 skipped. (`5db0b6d`) **Deferred:** the production etcd-backed adapter remains a separate future package (unchanged from the 2026-07-19 note); the completion criteria above are met by the in-process adapter.

**2026-07-23 quality correction:** The preceding “completed” claim was invalid: a process-local object that counted names in a `Set` was neither an etcd adapter nor a distributed quorum and could not meet this task's stated scope. The CLI now exports a real `EtcdControlStore`. Authoritative resource state, ordered replay event, logical revision, and idempotency response commit in one etcd transaction; CAS, historical list pagination, direct resilient watch, logical compaction, authenticated backend snapshots, native expiring leases, durable monotonic fencing epochs, health, and real member add/promote/update/remove operations are implemented. The executable selects it with `--control-store=etcd`, supports multiple endpoints, password-via-environment authentication, CA trust, and mTLS client credentials. Core remains free of etcd dependencies.

The pinned real-cluster acceptance starts etcd 3.6.11 by immutable image digest as one voter, adds two non-voting learners one at a time, waits for replication, promotes both, enables authentication, and then stops the elected leader. The two remaining voters still commit; after a second voter is stopped, the same authoritative write fails closed with `UNAVAILABLE`; restarting it restores writes without losing either pre-failure or post-leader-failure acknowledged state. Fencing advances 1→2 and an authenticated backend snapshot succeeds. A three-test real-etcd conformance suite independently covers cross-client CRUD/CAS/idempotency/watch, snapshot-stable pagination, native lease expiry/renew/release, compaction cursors and retained boundary state, health, membership, and snapshot. CLI build/declarations, 400 ordinary tests (+5 environment-gated skips), real etcd 3/3, boundary enforcement, packed-manifest inspection, and the 1→3 failure/recovery drill passed. (`a8c50c4`)

**2026-07-26 quality correction (in-process watch semantics):** `QuorumControlStore.watch` previously ignored every watch option and always started at the current revision. That made `sendInitialEvents` consumers miss pre-existing resources and made post-disconnect resume impossible, contradicting its claimed revision tracking. It now installs a gap-free live subscription around a stable initial snapshot, emits initial `ADDED` events plus a `BOOKMARK`, replays retained events after an explicit resourceVersion, returns terminal `WATCH_COMPACTED`/`INVALID` errors for unusable cursors, honors abort and timeout, and retains the replay log and compaction boundary across snapshots. Explicit and bounded automatic compaction prune both watch history and eligible tombstones. Four focused tests cover snapshot-to-live delivery, cancellation, replay/compaction, and snapshot restore. This correction strengthens the test/in-process adapter; the production etcd acceptance above remains authoritative for distributed quorum.

**2026-07-26 Apply/lease/delete parity correction:** The same audit applied the atomic Apply contract to the real etcd adapter with one compare transaction over the logical revision, resource, event, and operation-scoped idempotency record. The Quorum test adapter now persists idempotency separately from resources and snapshots it, enforces authorization on create/delete/status and all lease mutations, validates lease TTL and full holder/ID/epoch identity, preserves lease acquisition time on renewal, rejects stale release, keeps status generation stable, honors dry-run, and exposes the public `{ accepted, reference }` delete result instead of its obsolete `{ deleted }` cast. Finalizers remain visible with a deletion timestamp until declaratively cleared. The etcd integration suite contains five cross-client cases including Apply and finalizer/idempotent deletion; they compile in the ordinary CLI run but are conditionally skipped when `MEMELOOP_TEST_ETCD_ENDPOINTS` is absent. The pinned three-member etcd 3.6.11 acceptance was extended and rerun: 1→3 learner promotion, authentication, leader loss, quorum-loss rejection, recovery, fencing 1→2, and snapshot passed alongside a real atomic Apply that preserved UID/status, advanced generation only for the spec change, and rejected drift under a no-op-bound idempotency key.

**2026-07-26 shared ControlStore conformance correction:** Added one backend-neutral five-case suite for atomic desired/status state, operation-scoped idempotency/CAS/dry-run, ordered resumable Watch/abort, lease renewal/release/fencing, and finalizer/health/snapshot/compaction maintenance. It runs unchanged against Quorum, SQLite, and real etcd rather than allowing backend-specific tests to encode different semantics. The first SQLite run exposed that release deleted the only persisted lease epoch, so a later holder incorrectly returned to epoch 1; release now retains an expired lease tombstone and restart-safe epoch. Quorum and SQLite pass 5/5. The pinned authenticated three-member acceptance now runs the complete six-test etcd file (the shared suite plus the five native cross-client/membership cases) before leader/quorum failure injection; all 6/6 passed, followed by the existing leader-loss write, quorum-loss rejection, recovery, fencing, atomic Apply, and snapshot assertions.

### 24.60 Implement Fleet rollout controller

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** batch, canary, maxUnavailable, pause, deadline, rollback, and evidence aggregation.
**Completion criteria:** Hundreds of restricted fake workers use local loops/models/tools under bounded concurrency and budget; rollout pauses on configured failure/drift/security thresholds.
**Implementation record:** 2026-07-18 — `createFleetRolloutController` implements batch and canary rollout strategies. Batch processes targets in configurable batches with maxUnavailable tracking; canary advances through weighted stages with optional pause durations. The controller checks deadline before each reconcile, pauses on configurable failure thresholds, and records per-target evidence (success/failure with timestamps). Seven conformance tests cover initialization, batch processing, completion, pause on failure, canary stages, deadline, and skip-completed. 2026-07-21 — Kimi K3 added: (1) `maxConcurrency` field with `processTargetsBounded` worker pool for bounded parallel target processing (batch and canary); (2) `autoRollback` field that automatically rolls back updated targets when failure threshold or deadline is exceeded; (3) `maxUnavailable` enforcement that pauses rollout when unavailable replicas exceed the configured limit. Tests: 13/13 passed (6 new: 2 concurrency, 2 maxUnavailable, 2 autoRollback). Core build passes, targeted lint clean.
**Remaining debt (2026-07-21):** Tests use single-digit mocked targets; the hundred-worker end-to-end criterion is not met. Per-run model budgets, drift detection, and security-threshold pauses declared in Section 8 are not enforced.
**2026-07-23 (K3, debt cleared):** §8.8 thresholds enforced — `updateTarget` returns metered `{ tokens, cost }` usage, `status.consumedBudget` is derived from evidence on every path; aggregate `budget` pauses between batches/stages (overshoot bounded by in-flight batch); `perTargetBudget` converts over-consuming targets into failures; `pauseOnDriftThreshold`/`pauseOnSecurityThreshold` pause on host-observed drift/security findings before further updates. Scale e2e (`fleetRolloutScale.test.ts`): 200 fake restricted workers running simulated local loops with metered token streams under tracked bounded concurrency, all four threshold types, plus a 150-worker rollout converging to Completed through `createControllerRunner` + `QuorumControlStore`. The scale e2e exposed a latent runner bug: requeue/retry timers reconciled stale resource snapshots (infinite stage reprocessing + CAS failures) — now re-gets the current resource. Validation: core 854/854, CLI 357+2 skipped. (`c406ac9`) **Deferred:** fake workers simulate local loops/models (metered streams); a physical fleet run with real restricted nodes belongs to 24.64 final acceptance.

### 24.61 Publish driver manifests and conformance harness

**Status:** complete (quality audit closed 2026-07-27)
**Completed by model:** DeepSeek V4 Pro (K3); Kimi K3 — verified completion
**Scope:** portable fixtures and Node harness.
**Completion criteria:** Every interface has fake drivers, record/replay fixtures, capability negotiation, errors, cancel/backpressure, crash/adoption, idempotency/fencing, downgrade, and security tests.
**Implementation record:** 2026-07-19 — `driverConformance.ts` exports `DriverManifest`, `DriverConformanceSuite`, and `runConformanceSuite` for declarative driver testing. `driverConformanceFixtures.ts` adds `RecordingDriver`, `DriverFixture`, `createRecordingDriver`, and `createReplayingDriver` for deterministic record/replay. Conformance generators cover cancel/backpressure (abort semantics), crash/adoption (reconnect with known state), idempotency/fencing (stale tokens rejected), downgrade (newer protocol rejected), and security (unauthorized actor rejected). Fake drivers support latency/failure injection. Total: 16 fixture tests + 6 driver tests + 12 external driver tests = 34 tests; core build and targeted lint pass.
**2026-07-26 quality audit:** The completion claim was not supported by the implementation. The harness had dedicated fakes/suites only for network, model-provider, tool-execution, and external-orchestrator; its driver-kind union omitted ControlStore, loop runtime, tool catalog, artifact, identity/attestation, policy/approval, and audit/telemetry. The registered `DriverManifest` also omitted most mandatory §11 declarations. The manifest schema now covers every §10 interface plus execution location/transport, trust classes, resource kinds, downgrade behavior, host privileges, isolation/threat assumptions, configuration schema and SecretRefs, health, lifecycle, and explicit conformance evidence. Passing evidence is content-addressed and distinct from discovery; a manifest is selectable only when both its status is `Ready` and its conformance status is `passed`. External driver discovery honestly records `not-run` instead of treating shape validation as backend lifecycle conformance. Validation: core 965/965 and CLI 410 passed + 5 explicitly skipped; both production/declaration builds pass; core lint has no errors and CLI lint has only four pre-existing unused-disable warnings. Dedicated contracts, fakes, fixtures, suites, and consumer admission wiring remain open.
**2026-07-26 common request envelope:** Added a portable, versioned `DriverRequestEnvelope` carrying bounded resource identity, optional Run/attempt and fencing scope, request/idempotency identity, deadline, actor/session identity, opaque capability handle reference, trace context, canonical payload-schema digest, and payload. Its validator rejects unknown top-level or nested fields, unsupported actor kinds/newer versions, expired or excessively distant deadlines, invalid generations/attempts/epochs, missing method-required scopes, and malformed digests before driver invocation. It is exported through the portable entry point. Validation: 12/12 focused tests, production/declaration build, targeted lint, and portable-boundary checks pass.
**2026-07-26 managed Loop Runtime contract:** Added the portable `LoopRuntimeManagementDriver`, distinct from the existing narrow execution facade, with explicit capabilities plus Prepare, Start, Watch, Checkpoint, Restore, Cancel, Inspect, Adopt, and Delete. Its stateful fake reference can be recreated over a durable injected state to exercise crash adoption. Every lifecycle operation validates the common request envelope, resource/Run/capability scope and fencing epoch; idempotency keys and opaque preparation/run/checkpoint handles are resource-UID scoped, stale epochs and cross-resource handle use fail closed, and cleanup is idempotent. A reusable five-case conformance suite covers capability/threat declarations, idempotent prepare/start, the complete lifecycle, resource isolation, restart adoption, and stale fencing. Validation: conformance 5/5; core full suite 978/978; production/declaration build, targeted lint, and portable-boundary checks pass. Adapters for the production in-process/process runtimes and the remaining §10 interface suites remain open.
**2026-07-26 production execution adapter:** Added `createManagedLoopRuntimeAdapter` to put existing in-process/process `LoopRuntimeDriver` implementations behind the managed protocol. It resolves host-owned launch material during Prepare, binds resolved Run identity to the signed envelope, preserves resource-scoped idempotency/fencing, streams initial and terminal status, enforces request deadlines while watching/cancelling/deleting, and makes cleanup idempotent. Because the narrow runtime holds live handles only in daemon memory, the adapter forces honest `persistence: process` and rejects any claim of checkpoint, restore, or crash adoption; those methods return structured `UNSUPPORTED`. Tests exercise a real in-process script through Prepare → Start → Watch → Completed plus cancellation, deadline, scope, stale epoch, identity-drift, and dishonest-capability paths (5/5 focused). Validation: core full suite 983/983. NodeRuntime/controller routing and durable process-runtime adoption remain open.

**2026-07-26 production execution routing correction:** Added `createManagedLoopRuntimeExecutionRoute`, a round-trip bridge that keeps the existing controller-facing `LoopRuntimeDriver` surface while forcing every real effect through managed Prepare, Start, Watch, and Cancel. Ephemeral script source, resolved model/network bindings, and host volume paths remain in daemon memory and never enter the management payload or ControlStore. The adapter now requires a trusted capability verifier by default, validates exact AgentRun API/kind/name/UID/generation plus attempt, rejects unknown/secret-extension payload fields and non-canonical runtime/script digests, fingerprints the complete authority and input for idempotency drift, and preserves terminal summary and structured errors across the bridge.

NodeRuntime creates daemon-lifetime random capability/session values, constructs method-bound envelopes only after the durable AgentRun pre-effect CAS claim, uses the attempt as the per-resource fence, derives canonical RuntimeClass/schema digests, and exposes the honest process-local management surface as `managedLoopRuntimeDriver`. Both host-profile and real Linux process-isolated script E2Es now traverse this route; the process test still proves a distinct PID and the workload/AgentRun retain the terminal summary. Core route tests separately prove that Prepare/Start/Watch authorization is invoked and that outcome metadata survives. The remaining runtime limitation is unchanged and explicit: process-local handles cannot be adopted after daemon restart, so a claimed non-terminal Run is failed as `UNKNOWN_EFFECT` rather than started twice. Validation: core 1026/1026; CLI 413 passed with 8 explicit environment/integration skips; every other workspace suite, all production/declaration builds including Node 24 CLI, portable boundaries, and lint with zero errors passed (four unrelated pre-existing unused-disable warnings). (`4876b8e`)
**2026-07-26 managed Storage contract:** Added a portable `StorageManagementDriver` with separate complete Controller and Node lifecycles: capabilities, provision/delete, snapshot/restore, monotonic expansion, replica health/rebuild, backup, stage/publish/unpublish/unstage, and stats. Its durable-state fake scopes every opaque volume/snapshot/backup/stage/publication handle and idempotency record to the resource UID, enforces fencing on every operation, rejects shrink and out-of-order cleanup, and can be recreated over retained state. The five-case conformance suite covers capability/threat claims, idempotent allocation and expansion, restart-persistent data-management handles, ordered Node cleanup, stale fencing, and cross-resource handle rejection. Common envelope validation now also binds an invocation to its expected method, closing a method-confusion gap in both managed storage and loop-runtime drivers. Validation: storage conformance 5/5, all 20 request/managed-runtime/storage focused tests, and core 993/993 pass; lint, portable-boundary checks, and production/declaration build pass. A production adapter for the existing narrow storage drivers and the remaining §10 interface suites remain open.

**2026-07-27 production Storage adapter and controller routing:** Added `createManagedStorageDriverAdapter` over the existing CSI-like `StorageDriver` without overstating the narrow backend. It exposes real provision/delete and node stage/publish/unpublish/unstage behavior; snapshot/restore, expansion, replication/rebuild, backup, and statistics fail explicitly with `UNSUPPORTED`, and capability negotiation reports all of those features false. Every supported effect validates the method-bound envelope, host capability, resource fence, exact resolved Claim/Class/Volume scope, strict payload fields, node topology, access mode, ordered cleanup, cross-scope handle collisions, and semantic idempotency drift. Host authority is revalidated on every call while daemon-random session/capability rotation does not prevent legitimate adoption of already persisted semantic operations.

NodeRuntime now stores non-secret fences, operation fingerprints, stage handles, and publication links in atomically replaced, file-flushed private host state under the volume root. Claim provisioning and Run stage→publish→unpublish→unstage are routed through canonical schema-digest envelopes after the existing pre-effect ControlStore claims; stage handles are retained in AgentRun status so restart cleanup remains ordered. Raw mount paths remain host-only and never enter ControlStore. The adapter rejects deleting staged volumes and unstage-before-unpublish. Focused evidence covers the production adapter/controller routes (11/11), durable file store and real local driver (3/3), and the real SQLite/isolated-process NodeRuntime volume lifecycle (7/7, including managed host-persistence capability and opaque status). Full validation: core 1033/1033, CLI 414 passed with 8 explicit environment/integration skips, every other workspace suite, all production/declaration builds including Node 24 CLI, portable boundaries, and lint with zero errors passed (four unrelated pre-existing unused-disable warnings). Tool production routing is the next §24.61 substep. (`dd5e3eb`)

**2026-07-28 Storage authority/capability correction:** The earlier managed Storage route trusted binding-time capability selection, accepted under-capacity native results, and could adopt a handle without rechecking its Claim/Class/access/capacity scope. Binding also ignored StorageClass promises for snapshots, replication, and backup. One shared capability predicate is now enforced both while selecting an endpoint and immediately before provisioning; the managed adapter repeats the check against the resolved authoritative resources and validates both new and adopted native results. Replication is advertised by the local driver only when NodeRuntime has also wired the host replica transport/controller. The same audit corrected §24.45's no-op fence and added production runtime routing plus an end-to-end fence-before-transfer convergence test. Focused core evidence is 24/24; complete workspace and acceptance totals are recorded in §24.64 after the exact-worktree rerun.
**2026-07-26 managed Credential Broker contract:** Added a portable `CredentialManagementDriver` covering capabilities, Issue, Renew, Revoke, Inspect, and opaque materialization for an explicitly bound trusted driver. Its durable-state fake binds every grant to resource/Run/attempt, worker key, target, method, driver audience, canonical policy digest, expiry, exposure, and rotation requirement. It enforces maximum TTL, request method/capability/fencing, resource-scoped handles, session-key binding, single-use proof challenges, revocation of derived materializations, and idempotent issue/renew/materialize/revoke. The five-case conformance suite covers declarations, bounded retries, proof replay and revocation, restart persistence, stale fencing, foreign handles, and worker-session drift. No raw credential material appears in the interface. Focused conformance and production/declaration build pass. Adapting the existing signed broker and routing the CredentialGrant controller through this protocol remain open.
**2026-07-26 production credential adapter:** Added `createManagedCredentialBrokerAdapter` over the existing signed `CredentialBrokerDriver`. It creates a stable non-token handle, preserves idempotency and fencing, verifies the complete signed grant scope plus proof-of-possession before asking a trusted target driver for an opaque materialization, rejects target-driver/audience drift and unsupported exposure claims, detects materialization-handle reuse across scopes, and revokes derived handles with the grant. It honestly advertises `persistence: process` because stable handle and idempotency state are not yet durable, even if the injected signer is external. Tests use the real signed in-memory broker and cover issue/renew/materialize/revoke, hidden signed tokens, proof verification, collision detection, stale fencing, target drift, worker-key drift, and fail-closed exposure negotiation (2/2; all related tests 10/10). Validation: core 996/996; lint, portable-boundary checks, and production/declaration build pass. CredentialGrant controller routing and a durable production broker remain open.

**2026-07-26 credential identity correction:** The managed Issue contract previously carried only the abbreviated envelope Run UID/attempt. The production adapter incorrectly combined that UID with the CredentialGrant resource API/kind/name when signing the broker token, creating a mixed identity that was neither a valid RunRef nor a valid grant reference. `CredentialIssuePayload` now carries the exact non-secret Run API/kind/name/UID and must match the envelope Run UID; the CredentialGrant resource UID remains a separate handle/idempotency scope. A focused signed-broker test now deliberately uses different grant and Run UIDs and verifies both identities and the attempt. Controller routing remains open until capability verification and strict idempotency/payload checks are applied to this corrected contract.

**2026-07-26 credential adapter authorization correction:** The production adapter now requires a trusted host `authorizeRequest` verifier on every Issue/Renew/Revoke/Inspect/Materialize call; a merely non-empty capability string is no longer authority. Operation-scoped idempotency records bind the complete resource, Run, session, opaque capability reference, schema digest, and payload, so a retry with drift fails `CONFLICT` instead of returning an unrelated prior grant/materialization. Focused real-broker tests prove both capability denial and Issue drift rejection. Strict nested payload validation and controller routing remain the next credential substep.

**2026-07-27 production credential routing and restart adoption:** Closed the remaining credential substep instead of routing only the happy path through the new interface. The signed-broker adapter now rejects unknown fields at every Issue/Renew/Revoke/Inspect/Materialize payload boundary (including nested RunRef and proof objects), requires canonical policy digests and exact Run/resource separation, and binds revoke idempotency to its complete authorized input. With an injected trusted `CredentialHandleVault`, it persists the signed token only under a deterministic opaque host handle, advertises honest `persistence: host`, and recreates/adopts the exact signed scope after daemon restart; without that store it continues to advertise process-only persistence. Scope drift conflicts rather than issuing a second credential. A vault write failure immediately revokes the just-issued grant and returns terminal `UNKNOWN_EFFECT`, so no valid but unreachable credential is left behind.

`createNodeRuntime` now constructs a daemon-random capability and session, canonical method-specific payload schema digests, exact CredentialGrant/AgentRun identities, and lease-epoch fencing envelopes. CredentialGrant Issue, terminal/expiry lifecycle Revoke, deletion cleanup, and Run-completion cleanup all traverse `CredentialManagementDriver`; the old narrow broker remains only as an explicit compatibility fallback for hosts that construct the controller directly. ControlStore receives only the stable handle and non-secret timing/exposure status. The real SQLite NodeRuntime test uses the signed broker plus an external vault, proves host-persistent capabilities and token absence from ControlStore, and observes managed revocation/erasure when the Run completes. Focused validation: core adapter/controller 12/12 and CLI runtime E2E 1/1. Full validation: core 1029/1029, CLI 413 passed with 8 explicit environment/integration skips, every other workspace suite, all production/declaration builds including Node 24 CLI, portable boundaries, and lint with zero errors passed (four unrelated pre-existing unused-disable warnings). The Credential interface's production adapter, controller routing, strict boundary, and restart-adoption evidence are complete; Storage and Tool production adapters are the next §24.61 work. (`99b01a5`)

**2026-07-28 credential host-persistence quality correction:** Reverse audit found that the production adapter above upgraded itself to `persistence: host` when only the signed-token vault was durable, while its fencing epochs, semantic idempotency records, and derived-materialization revocation index remained process-local. After a daemon restart an old controller epoch could therefore be accepted and a materialization already installed in a target driver could disappear from grant-revocation cleanup. Host persistence now requires both the secret `CredentialHandleVault` and a separate non-secret `ManagedCredentialAdapterStateStore`; a vault without management state is reported honestly as process persistence. NodeRuntime supplies the same atomic, file-and-directory-flushed private state store used by managed storage under a credential-specific directory. Durable operation fingerprints retain resource, Run, actor, worker key, schema, and payload bindings while intentionally excluding daemon-random capability/session identifiers; every replay is still authorized against the new live capability before durable adoption. Restart tests recreate both the adapter and signed broker, prove stale-fence rejection, adopt the exact vault token, persist materialization indices, and revoke the target materialization plus vault entry from the new process. Renewal does not replace the live in-memory token until the vault write succeeds, and a post-effect materialization-state failure attempts explicit target cleanup and returns terminal `UNKNOWN_EFFECT` with bounded non-secret evidence. Focused validation: managed adapter 7/7; NodeRuntime credential and file-state integration 4/4. Full validation: core 1075/1075, CLI 422 passed with six explicit real-etcd environment gates, worker 7/7, Kubernetes 33/33, Swarm 24/24, libp2p 23/23 plus browser boundary, protocol 6/6, React UI 33/33, and acceptance helpers 10/10; core and Node 24 CLI production/declaration builds, full lint, portable boundaries, and the complete final acceptance runner pass.

**2026-07-26 managed Artifact contract:** Added a portable streaming `ArtifactManagementDriver` covering content-addressed Put/Resolve/Read, Scan, Sanitize, narrow Verify, destination-scoped Promote, Quarantine, read-only Mount/Unmount, and Delete. Its bounded durable-state fake computes SHA-256 over exact bytes, permits separate ArtifactRecord identities to reference identical content, rejects hash/metadata/idempotency drift, preserves lowest input taint and lineage through derived sanitized content, binds append-only review evidence to content/policy/destination/reviewer, and invalidates promotions and mounts on quarantine. The deterministic verifier certifies only implemented properties rather than trusting caller assertions; hostile prompt-injection/MIME findings quarantine content. Five conformance cases cover capability/threat declarations, bounded streaming and restart recovery, hostile scanning, sanitization/verification/promotion/mount, stale fencing, and foreign handles. The fake truthfully declares `inspectionIsolation: none`; it is not accepted as a production sandbox. Validation: focused artifact tests 24/24 and core 997/997; lint, portable-boundary checks, and production/declaration build pass. A production adapter must run parsing/scanning outside the controller and remains open.

**2026-07-27 production Artifact adapter, isolated inspection, and script routing:** Added `createManagedArtifactDriverAdapter` around the complete Artifact lifecycle with a mandatory trusted capability verifier, exact payload boundaries, canonical policy/content digests, bounded review targets/properties/findings, serialized mutations, and a mandatory durable-state commit after every accepted request. JSON-safe host snapshots contain exact bytes plus descriptors, mounts, idempotency, and fences; restore rebuilds content indexes and rehashes every byte before accepting state. A failed host commit returns terminal `UNKNOWN_EFFECT` and releases the serialization lock without pretending the mutation was absent. The reference engine now accepts an `ArtifactInspector` port while retaining its deterministic in-process inspector only for conformance tests.

The CLI production inspector runs every scan, sanitize, and narrow verification in a fresh Node 24 subprocess with content-free argv and a minimal environment, bounded stdin/stdout, an 8 MiB hard ceiling, V8 memory limit, deadline, fail-closed exit handling, and no shell. It detects hostile instruction patterns and MIME/archive magic confusion, strips terminal controls and active markup, and rejects ZIP/gzip/tar/RAR/7z instead of expanding paths, links, or archive bombs. It honestly reports `inspectionIsolation: process`; Electron embedders may inject a `utilityProcess`-backed inspector and declare its actual isolation. `ELECTRON_RUN_AS_NODE` keeps the default fallback usable with an Electron executable when that fuse is enabled.

NodeRuntime persists the driver snapshot through private atomic file replacement + file/directory fsync and exposes `managedArtifactDriver` with `persistence: host`. Generated scripts now traverse Put → isolated Scan → isolated content-hash Verify → destination-policy Promote before workload creation; workload and external-driver source resolution read the promoted managed bytes, not the legacy file. The old `.mjs`/manifest files remain only as a compatibility mirror. Real SQLite NodeRuntime evidence rejects a valid-AST prompt-injection script before scheduling, executes a safe promoted script, proves mirror tampering cannot alter the authoritative bytes, and adopts the verified artifact after daemon restart. Focused evidence: production adapter/reference lifecycle 4/4, isolated inspector and real Node routing 10/10. Full validation: core 1038/1038, CLI 416 passed with 8 explicit environment/integration skips, every other workspace suite, all production/declaration builds including Node 24 CLI, and portable boundaries pass. Full lint has zero errors; only four unrelated pre-existing unused-disable warnings remain. Identity/Attestation, general Policy/Approval, and Audit/Telemetry production routes remain open. (`4762938`)
**2026-07-26 managed Identity/Attestation contract:** Added a portable `IdentityAttestationManagementDriver` with Enroll, Challenge, Attest, IssueSession, Rotate, Revoke, and Inspect across separately typed enrollment, workload, device, and control-plane identity domains. Its durable-state fake enforces actor roles, deadlines, fencing, bounded TTL, one-time challenges, measured-evidence allowlisting, proof-of-possession, exact channel binding, domain-preserving sessions, idempotency input fingerprints, resource-scoped handles, key rotation, and cascading session revocation. Attestation retries with the same idempotency input converge, while a new request cannot replay a consumed challenge. Five conformance cases cover complete bootstrap/session lifecycle, restart inspection, rotation/revocation, idempotency drift, channel drift, proof replay, domain confusion, stale fencing, and foreign handles. Validation: focused management plus existing WorkerEnrollment/identity lifecycle tests 19/19 and core 998/998; lint, portable-boundary checks, and production/declaration build pass. The existing WorkerEnrollment path remains a narrower consumer and is not yet routed through this general driver.

**2026-07-27 production Worker Identity/Attestation routing:** Added `createManagedWorkerIdentityAdapter`, which places the existing one-time `WorkerEnrollment` bootstrap and durable `WorkerSession` issuance behind the general managed lifecycle. The trusted host keeps the raw bootstrap token and verifier callbacks outside every driver envelope, digest, ControlStore resource, and log. Enroll resolves the exact durable enrollment; Challenge binds the expected gateway, audience, and worker key; Attest consumes the real token verifier and Ed25519 proof verifier exactly once; IssueSession then delegates to the existing store transition, which rechecks the durable enrollment/session scope without consuming the one-time proof a second time. The resulting session remains bound to the worker key, audience, Run UID/attempt/epoch, policy digest, protocol, TTL, and replay fence already enforced by `WorkerSession`.

The production adapter validates exact payloads, actor/session/capability authority, resource identity, method, deadlines, fencing, bounded inputs, stable idempotency fingerprints, challenge/channel/evidence binding, and session scope. Raw proof material exists only in a serialized process-local pending binding and is erased on every success or failure; concurrent binding of the same enrollment fails closed. Capabilities therefore honestly report `persistence: process`, no rotation, and the narrow `worker-ed25519-bootstrap/v1` format. This is software-key proof of possession, not TPM, measured-boot, secure-boot, or hardware attestation, and it does not manufacture a higher trust class.

`createNodeRuntime` now owns a daemon-random identity capability/session, constructs canonical method-specific schema envelopes, exposes `managedIdentityDriver`, and routes the worker HTTP bootstrap endpoint through this adapter; the old direct helper remains only as an explicit handler compatibility fallback. A real external worker E2E traverses enrollment, signed gateway proof, managed identity lifecycle, ModelGateway work, and durable WorkerSession creation. Regression evidence also covers rejected proof/capability/extensions, single-consumption verifiers, and idempotency drift. Full validation: core 1040/1040, CLI 416 passed with 8 explicit environment/integration skips, every other workspace suite, all production/declaration builds including Node 24 CLI, and portable boundaries pass. Full lint has zero errors; only four unrelated pre-existing unused-disable warnings remain. General Policy/Approval and Audit/Telemetry production routing remain open. (`185975a`)

**2026-07-26 managed Policy/Approval contract:** Added a portable `PolicyApprovalManagementDriver` covering AdmitResource, AuthorizePlacement, AuthorizeToolOperation, RequestApproval, verifier-only VerifyTransition, and ExplainDecision, plus the necessary authenticated admin ResolveApproval action. Every immutable decision records an opaque resource-scoped handle, policy and normalized-input SHA-256 digests, authenticated actor, reasons, obligations, and trusted time. The durable-state fake uses only host-injected allow rules, defaults to deny, requires capability/deadline/method/fencing validation, rejects idempotency drift and foreign handles, and retains decisions across recreation. Approval starts pending, expires fail closed, can be resolved only by an admin, is immutable after resolution, and is bound to the exact operation digest and policy so it cannot authorize another effect. Transition promotion is separately restricted to verifier actors and allowlisted transitions with canonical evidence digests. Five conformance cases cover declarations, resource/placement default denial, restart-persistent approval and cross-operation replay rejection, verifier-only explanation, stale fencing, foreign handles, and retry drift. Validation: conformance 5/5, core 999/999, full lint, portable-boundary checks, and production/declaration build pass. Existing in-process tool admission remains defense in depth; controller-owned request construction, durable PolicyDecision resource routing, and host approval UI integration remain open and must not be replaced by fabricating controller envelopes inside the executor.

**2026-07-27 production Policy/Approval persistence and routing:** Added `createControlStorePolicyApprovalAdapter` and the create-only `security.memeloop.io/v1alpha1 PolicyDecision` evidence resource. Every decision atomically stores the exact subject UID/generation, method-bound authority fingerprint, idempotency key, fence, canonical input/policy digests, actor, reasons, obligations, trusted receiver time, and initial outcome; no tool arguments or approval secrets are copied into decision evidence. Deterministic names make acknowledged decisions adoptable after daemon restart. Input drift, cross-resource handles, stale fences, unsupported payload extensions, expired approvals, and missing host evaluators fail closed. Pending approvals may be resolved only once by an authenticated admin; unresolved approvals read as denied after expiry.

`createPolicyDecisionAuthorizer` enforces those invariants inside the same ControlStore write transaction: ordinary decisions and pending approvals are create-only, transition decisions require a verifier, only an admin may resolve an approval status, and apply/delete/lease operations are rejected. This audit found that the SQLite and etcd `create` paths did not pass `proposedResource` to their authorizer, making spec-aware create authorization impossible; both production stores now pass the exact manifest, with a SQLite regression assertion. The CLI-owned SQLite store and configured etcd store install the PolicyDecision authorizer; injected stores must provide the same trusted authorization boundary as documented by the adapter capability.

NodeRuntime owns daemon-random policy capability/session values and canonical per-method request schemas, exposes `managedPolicyDriver`, and injects only host-resolved evaluators. Real ToolOperation execution now persists RequestApproval → authenticated host-UI ResolveApproval → AuthorizeToolOperation decisions before the existing managed tool authorization; the durable PolicyDecision handle replaces the former process-only fabricated hash. AgentWorkload binding independently performs managed AuthorizePlacement after scheduler eligibility and before assigning a node, then stores the exact decision handle and policy digest in workload status. External scheduler inventory must explicitly carry host-verified driver conformance; absence denies placement. Resource admission and verifier transitions are exposed as default-deny host-evaluated production methods, while existing resource-specific ControlStore authorizers remain the final transactional boundary.

The first full run also exposed a cross-clock Identity retry bug: deriving managed TTL from ControlStore `creationTimestamp` coupled two clock implementations. Worker enrollment and challenge requests now use stable configured bounds while the durable absolute `expiresAt` remains authoritative and clamps every result. Focused evidence covers durable approval/recreation/expiry, forged controller resolution, idempotency/capability/scope/fence drift, scheduler allow/deny evidence, SQLite create authorization, real ToolOperation UI approval, and real workload placement. Full validation: core 1044/1044, CLI 416 passed with 8 explicit environment/integration skips, every other workspace suite, all production/declaration builds including Node 24 CLI, and portable boundaries pass. Full lint has zero errors; only four unrelated pre-existing unused-disable warnings remain. Audit/Telemetry is the remaining §24.61 production route. (`a79cd58`)

**2026-07-26 managed Audit/Telemetry contract:** Added a portable `AuditTelemetryManagementDriver` for AppendAudit and typed event, metric, and trace emission, plus bounded read/chain verification. Records take actor, resource, capability, and trusted receiver time only from the validated host envelope; store only a digest of the opaque capability; and require canonical policy, effect, and provenance metadata. The interface accepts no arbitrary log payload or caller timestamp. Attributes are count/size bounded and fail closed on secret-shaped keys or values using the common secret detector. The durable-state fake serializes concurrent appends, enforces per-resource quotas, scopes idempotency and fencing, preserves records across recreation, and links the global append-only stream with SHA-256 digests. Reads revalidate every link and digest before returning resource-scoped records; no delete or rewrite method is exposed. Five conformance cases cover explicit security/retention capabilities, trusted metadata/time, all telemetry types and secret rejection, restart/idempotency/chain verification, quotas, stale fencing, retry drift, and foreign-stream isolation. Validation: conformance 5/5 and core 1000/1000; full lint, portable-boundary checks, and production/declaration build pass. A production external/ControlStore sink and routing of the existing WorkerProtocol, tool, and ModelGateway audit ports through this contract remain open.

**2026-07-27 production Audit/Telemetry closure:** Added the immutable `AuditRecord`, transactional append-only authorizer, and lease-serialized ControlStore adapter with restart-safe idempotency/fencing/quota and full-chain verification. NodeRuntime now routes ModelGateway, managed-tool, and accepted/rejected WorkerProtocol audit ports through its private managed capability without persisting prompts, outputs, arguments, payloads, credentials, or opaque capabilities. Production conformance, dual-adapter concurrency, immutable-write, and real SQLite routing evidence pass; full validation is core 1047/1047, CLI 416 plus 8 explicit skips, every other workspace suite/build, portable boundaries, and lint with zero errors/four unrelated existing warnings. This closes the final §24.61 managed-interface route. (`68b2a66`)

**2026-07-26 managed Tool Catalog/Execution contract:** Added a portable `ToolManagementDriver` covering capability discovery, content-addressed Discover/Describe, Prepare, trusted Authorize, bounded streaming Invoke, Inspect, unknown-effect reconciliation, evidence collection, and ordered Cleanup. Catalog construction recomputes the SHA-256 digest of each input/output schema and rejects caller-supplied placeholders or mismatches; the snapshot digest binds version, schema, effect/risk, target allowlist, idempotency, fencing, and evidence declarations. Preparation binds that exact snapshot and rejects schema/effect/target drift. Authorization is delegated to an injected trusted policy-decision verifier, is resource/preparation/policy scoped, has a maximum 60-second TTL, and cannot be replaced by a caller `allow` field. The durable-state fake applies method-specific actor roles, request/capability/fencing validation, resource-scoped opaque handles, input-fingerprinted idempotency, async-iterator backpressure, byte/chunk limits, cancellation, conservative UNKNOWN_EFFECT for interrupted side effects, explicit evidence/idempotency-based reconciliation, output digests, and cleanup ordering. Five execution conformance cases cover declarations, catalog/policy binding, completed stream replay, restart recovery and safe reconciliation, evidence, actor rejection, stale fencing, and cross-resource isolation. Because `tool-catalog` and `tool-execution` are independently selectable manifest kinds, a separate two-case catalog suite now emits catalog-only evidence rather than accepting execution evidence for discovery admission. Validation: execution 5/5, catalog 2/2, and core 1001/1001; full lint, portable-boundary checks, and production/declaration build pass. The existing narrow in-process driver/controller remains operational but is not yet routed through this protocol; its CLI `builtin:<tool>:v1` schema labels are non-canonical placeholders and must be replaced by actual schema digests in the production adapter.

**2026-07-27 production Tool Catalog/Execution routing:** Replaced the direct in-process `ToolOperation` execution path with `createManagedToolExecutionRoute`, so every host tool now traverses Discover → Prepare → trusted Authorize → bounded Invoke → Evidence → Cleanup after the controller has supplied its authenticated actor and lease fence. NodeRuntime owns a daemon-random capability/session, constructs method-bound envelopes with exact payload schemas, re-resolves the durable `ToolOperation` before policy authorization and again immediately before invocation, and rejects capability, resource, schema, effect, target, arguments, or fencing drift. Host admission remains authoritative; required approvals call the injected trusted UI broker once, validate authenticated allow evidence, bind it to the policy decision and operation, and pass only that evidence into the narrow executor. Ephemeral decision/approval material is removed on both success and failure.

The catalog is now derived from the schemas actually registered by the embedding host. Each tool publishes a canonical SHA-256 input/output schema digest and separate conservative read/create/update/delete/execute/unknown descriptors, eliminating every `builtin:<tool>:v1` placeholder while supporting multi-effect implementations. Completed operations persist only the output evidence digest. The production route deliberately reports `persistence: process`: completed read results are replayable only while the daemon state exists, and non-read cancellation or loss remains `UNKNOWN_EFFECT` rather than claiming crash adoption. Focused evidence covers canonical descriptors, complete lifecycle, evidence, capability and extension rejection (core 16/16), plus real SQLite NodeRuntime registration, execution, denial, one-shot approval, timeout, and deletion cancellation (CLI 4/4). Full validation: core 1035/1035, CLI 414 passed with 8 explicit environment/integration skips, every other workspace suite, all production/declaration builds including Node 24 CLI, portable boundaries, and lint with zero errors passed (four unrelated pre-existing unused-disable warnings). Artifact, Identity/Attestation, general Policy/Approval, and Audit/Telemetry production routes remain open. (`69d875e`)

**2026-07-27 default host-tool catalog quality correction:** A reverse audit found that the production route above was complete only for core and generic Node tools. The default CLI also registered file, terminal, wiki/knowledge, VS Code CLI, screenshot, and demo tools without passing their parameter schemas into the host registry. Those tools remained model-visible locally but were intentionally omitted from the managed catalog, so a default ToolLoop could select a tool that no `ToolExecutor` advertised or accepted. All production default-tool registrations now carry strict portable JSON schemas, including bounded enums and `additionalProperties: false` where applicable; core builtins, IM builtins, and plugin APIs likewise pass their declared schema through the execution registry instead of relying only on process-global metadata.

`ToolRegistry` now owns an instance-local schema map. Managed descriptor construction uses that map exclusively when the host supports it, preventing one embedded runtime from inheriting a stale process-global schema for a same-named schema-less tool; legacy registries retain the global fallback for compatibility and still fail closed when no schema exists. A zero-missing-schema gate registers the complete real Node environment, converts every instance schema, and verifies six content-addressed effect descriptors for every visible tool. A separate collision test proves that stale global metadata cannot widen another runtime. The SQLite NodeRuntime integration now publishes and executes the formerly omitted `file.list` through the complete managed ToolOperation route and verifies its durable completion. Focused evidence is 57/57; full core remains 1065/1065 and CLI is 421 passed with six real-etcd environment gates, with worker 7/7, Kubernetes 30/30, Swarm 22/22, libp2p 23/23, protocol 6/6, and React UI 33/33. Production/declaration builds, portable boundaries, changed-file formatting, and full lint pass with zero errors (the same four unrelated unused-disable warnings).

**2026-07-27 bound tool-input enforcement correction:** The catalog digest previously bound each input schema but the trusted Invoke implementation checked only that arguments were an object. A caller could therefore cross the declared contract with wrong types, out-of-range values, or additional properties and still reach the tool implementation. Managed Invoke now compiles the exact descriptor schema before accepting the catalog and validates arguments before creating execution/idempotency state or calling the narrow driver. Validation is non-mutating: it does not coerce types, insert defaults, or remove fields. Draft 7, 2019-09, and 2020-12 are selected explicitly; unsupported drafts and invalid schemas fail closed. The reusable conformance suite rejects schema-invalid invocation, and the real NodeRuntime test proves a malformed default `file.list` operation becomes durably `Failed/INVALID` without weakening the valid path. The added runtime dependency is Ajv 8.20.0; frozen offline install, full core 1065/1065, CLI 421 plus six real-etcd environment gates, all other workspace suites, production/declaration builds, portable boundaries, and lint pass.

**2026-07-27 tool permission/catalog parity correction:** `ToolRegistry.getTool` applied blocklist and allowlist together, but `listTools` returned immediately after applying a non-empty blocklist and silently ignored the allowlist. Because managed catalog publication consumes `listTools`, a denied tool could be advertised even though local lookup refused it. Both paths now use the same intersection: blocked tools are always excluded and a non-empty allowlist excludes every unlisted tool. A catalog-level regression proves only the effective allowed set receives descriptors. Focused managed/OpenAI/default-runtime evidence is 14/14; the complete CLI suite is 422 passed with six real-etcd environment gates, the Node 24 production/declaration build passes, and full lint is clean after removal of four obsolete suppression comments.

**2026-07-27 host-authoritative tool-effect correction:** The production catalog previously generated read/create/update/delete/execute/unknown descriptors for every registered implementation. Since a `ToolOperation` supplied its own effect and policy rules match that field, a caller could label `file.write` as `read`, select the fabricated read descriptor, and reach the write implementation under understated risk. `IToolRegistry` now carries one host-authoritative effect per registration; the CLI registry stores it instance-locally, plugins may declare it, and undeclared third-party tools conservatively default to `execute`. Default file, terminal, knowledge, VS Code, screenshot, generic Node, TODO, and IM tools now declare their actual static effect; dynamic/mixed tools remain `execute`.

Descriptor construction publishes only the declared effect. `ToolExecutor` capabilities carry that effect, placement filters it before binding, and the managed execution route independently requires an exact descriptor match before policy authorization. AgentToolLoop derives its operation effect from the same host registry rather than hard-coding or accepting a model-selected value. Regression evidence proves an understated effect cannot select an executor, the model path uses the host classification, and `file.read`/`file.write`/`bash` publish read/update/execute respectively. Full validation: core 1067/1067, CLI 422 passed with six real-etcd environment gates, worker 7/7, Kubernetes 30/30, Swarm 22/22, libp2p 23/23, protocol 6/6, React UI 33/33, production/declaration builds, portable boundaries, and clean lint.

**2026-07-26 managed Network contract:** Added the portable `NetworkManagementDriver` with GetCapabilities, PrepareNetwork, CheckNetwork, ResolveService, UpdatePolicy, and ReleaseNetwork. The durable-state reference validates the common method-bound request envelope, controller/admin authority, Run/capability scope, deadlines, resource UID, monotonic fencing, policy and NetworkClass digests, requested features, minimum verified enforcement level, trust class, and bounded rule count. Opaque network/service handles and input-fingerprinted idempotency records are resource scoped and survive recreation over retained state; drift, foreign handles, stale epochs, expired/method-confused requests, unsupported trust, and false enforcement requirements fail closed. Five reusable conformance cases cover declarations, exact idempotent preparation, full policy/service/cleanup lifecycle, restart adoption/fencing, and handle isolation; focused negative tests separately exercise weak process-level enforcement and actor/method/deadline rejection. Validation: managed Network plus common-envelope tests 16/16, portable-boundary guard, and production/declaration build pass. At this checkpoint, adapting the existing narrow node network driver and routing `NetworkAttachment` execution remained open; the correction below closes that process-driver routing gap.

**2026-07-26 production Network adapter and routing:** Added `createManagedNetworkAdapter` over the existing node-local `NetworkDriver` without inflating its security or durability claims. It derives enforcement capabilities from the native driver, forces `persistence: process`, binds prepare/check/resolve/release to an injected capability verifier, session, Run, resource UID/generation, numeric controller fencing epoch, canonical NetworkClass/effective-policy digests, exact sandbox handle, and resource-scoped idempotency fingerprint. It rejects resolved desired-state drift, foreign handles, stale epochs, method confusion, unknown top-level or nested policy fields (including secret-shaped extensions), invalid rules/ports/enums/bounds, and dishonest capability declarations. In-place policy mutation is explicitly `UNSUPPORTED` because the narrow process driver cannot safely reconstruct a changed class from the management request.

`NetworkAttachment` now records the exact owning `AgentRun` identity. The real NodeRuntime creates a daemon-lifetime random capability and session, constructs managed requests only inside the host controller boundary, derives policy/schema digests canonically, and routes both normal reconciliation and deletion cleanup through the managed driver. The persisted process-driver handle remains opaque but is still consumable by the process runtime for environment injection. The existing required-enforcement scheduler gate remains in front of this path; the process driver continues to state honestly that it only supplies cooperative process-level proxy behavior. A controller test proves that the narrow prepare/release methods are no longer invoked directly when management routing is configured, and the real SQLite-backed NodeRuntime e2e proves NetworkAttachment creation with Run binding → managed prepare → proxy environment consumption by an isolated script → managed release → Detached. Validation: core 1019/1019; CLI 413 passed with 8 explicit environment/integration skips; all other workspace suites passed; core and Node 24 CLI production/declaration builds passed; portable boundaries are clean; full lint has zero errors and four pre-existing unused-disable warnings. Remaining Network debt is a durable host/external adapter with restart adoption and real namespace/host/external enforcement; this process adapter deliberately does not claim either. (`d0347ad`)

**2026-07-26 managed Model Provider contract:** Added the portable `ModelManagementDriver` with policy-complete model descriptors, ListModels, Estimate, bounded streaming Generate, Cancel, InspectUsage, and Health. The durable-state reference validates the common method-bound envelope, trusted actor, Run/attempt, capability, worker-session key, resource UID, fencing, exact model digest, data classification, residency, context/request bounds, concurrency, and output-token budget before or during streaming. Unknown payload fields such as an API key fail closed. Calls persist only scoped usage/replay state behind opaque handles; the handle and idempotency fingerprint bind the capability, Run, session, and full request, and completed/cancelled calls remain inspectable across recreation. Cancellation creates a durable terminal stream record even when the consumer closes immediately, and streamed output cannot exceed its authorized token count. Five reusable conformance cases cover declarations, estimate/stream/replay/drift, restart/fencing, active cancellation, and handle isolation; focused negative tests cover capability, digest, classification, residency, budget, secret-field, method, deadline, and session drift. Validation: managed Model plus common-envelope tests 17/17, portable-boundary guard, and production/declaration build pass. The production ModelGateway already enforces equivalent model authority on the default loop path, but an explicit adapter/evidence mapping from that gateway to this general driver protocol remains open.

**2026-07-26 production ModelGateway adapter and Node routing:** Added `createManagedModelGatewayAdapter`, which exposes the real signed `ModelGateway` through the complete managed Model Provider protocol. It validates the method-bound host envelope, Run/attempt, capability, session, resource UID, fencing, exact canonical model digest, classification, residency, request shape, output and concurrency bounds before delegating to the gateway. The opaque signed token is resolved only inside a trusted host callback and is passed directly to `ModelGateway`; it is never retained in adapter state, usage, chunks, logs, or `ModelCallRecord`. Idempotency and inspection are bound to a non-secret authority fingerprint and the complete request, foreign resources/authorities and stale epochs fail closed, cancellation reaches the real gateway, immediate consumer disconnect cleans timers and active state, and terminal cancellation is recorded/replayed exactly once. Capabilities are forced to `persistence: process`; a recreated adapter deliberately cannot adopt calls, and dishonest host/external durability claims are rejected.

`createNodeModelGateway` now optionally supplies this managed driver over its real HMAC-signed broker, daemon-held provider executor, and ControlStore recorder. The resolver verifies audience, proof-of-possession worker key, exact Run UID/attempt, ModelClass, and digest before returning authority. NodeRuntime exposes the driver only when the embedding host supplies complete `managedModels` descriptors with real weight/provider-snapshot SHA-256 digests; mutable provider aliases are intentionally not converted into fake immutable identities. A real SQLite NodeRuntime e2e issues a signed Run/attempt/digest/worker-key-bound handle, streams through the managed driver and provider, and verifies the durable terminal `ModelCallRecord`. This audit also closed two lower-level gaps: a digest-bound gateway handle now rejects requests that omit the digest, and `ModelCallRecord.spec` persists the selected non-secret model digest for later proof. Core focused tests cover real signed generate/audit/replay, authority/idempotency/resource/fencing drift, restart non-adoption, immediate disconnect, and single terminal cancellation; Node focused tests cover the complete production wiring. Validation: core 1025/1025; CLI 413 passed with 8 explicit environment/integration skips; worker, K8s, Swarm, libp2p/browser, protocol, and React UI suites all passed; every production/declaration build (including Node 24 CLI), portable boundaries, and full lint with zero errors and four pre-existing unused-disable warnings passed. (`51a7815`)

### 24.62 Add Swarm and Kubernetes/K3s external drivers

**Status:** completed
**Completed by model:** DeepSeek V4 Pro (K3)
**Scope:** separate optional Node plugins after interfaces stabilize.
**Completion criteria:** AgentLoopRun and ToolOperation map independently, co-location is explicit, and no backend SDK enters core or default CLI dependencies.
**Implementation record:** 2026-07-19 — `externalDriver.ts`. Defined portable `ExternalOrchestrationDriver` contract in core. Twelve conformance tests validate the contract. 2026-07-21 — K3 added two concrete production packages:

- **`packages/memeloop-swarm`** (7 source files): `SwarmOrchestrationDriver` implements the full contract against the Docker Engine REST API via unix socket (`node:http`). Maps AgentWorkload → Swarm Service (ReplicatedJob/Replicated), ToolOperation → one-shot Service. Tested with `FakeEngineServer` (in-memory HTTP server mocking Docker API). Zero SDK dependencies (`dockerode` not required). TSC + vitest (focused) pass; dist/ built.

- **`packages/memeloop-k8s`** (5 source files): `KubernetesOrchestrationDriver` implements the full contract against the Kubernetes REST API via `node:https` (bearer token + optional CA). Maps AgentWorkload → Job/Deployment, ToolOperation → Job (with `ttlSecondsAfterFinished`). `KubernetesApiClient` is a ~160-line minimal REST client with no `@kubernetes/client-node` dependency. TSC passes; lacks standalone fake-server tests (only conformance-tested via core's fake driver).

Both packages are `"private": true`, depend only on `memeloop` (workspace), and avoid heavyweight orchestrator SDKs.

**Remaining debt (2026-07-21):**

1. **No container image exists.** The drivers inject `memeloop.io/runtime-image` annotation as the pod/service container image, but no `memeloop/loop-runtime` image is built or published. A K8s pod created by the driver has no Node.js runtime, no `memeloop` packages, and no entrypoint that reads `MEMELOOP_WORKLOAD` env to start a loop.
2. ~~`memeloop-k8s` has no `k8sDriver.test.ts` with a fake K8s API server (equivalent to swarm's `FakeEngineServer`).~~ **Cleared 2026-07-23 (K3):** `FakeKubernetesServer` emulates the Kubernetes REST endpoints (Status error shape, label-selector filtering, Job/Deployment/Pod state, failure injection); 14 driver tests cover placement by lifecycle, phase mapping, idempotency adoption, managed-by selectors, health, and HTTP→OrchestrationError mapping. memeloop-k8s 17/17, memeloop-swarm 13/13. (`2755673`)
3. ~~**No plugin discovery or registration mechanism.**~~ **Cleared 2026-07-23 (K3):** CNI-analogue discovery — the CLI reads `<dataDir>/drivers.d/*.json` manifests, dynamically imports the declared optional module, instantiates via the named export (factory or `construct: true` class), and structurally validates the `ExternalOrchestrationDriver` contract + capabilities; malformed manifests/unresolvable modules/non-conforming drivers are collected and skipped, never daemon-fatal.
4. ~~**No driver manifest registration.**~~ **Cleared 2026-07-23 (K3):** `DriverManifest` resource kind (`drivers.memeloop.io/v1alpha1`) added with builder + guard; the conformance `DriverManifest` kind union gains `'external-orchestrator'`; discovered drivers are registered into the ControlStore via idempotent apply, so the scheduler can discover them.
5. ~~Neither package is wired to CLI `start` or `createNodeRuntime`.~~ **Cleared 2026-07-23 (K3):** `createNodeRuntime` runs discovery + registration by default with dataDir + ControlStore (`externalDrivers.enabled=false` opts out) and exposes `NodeRuntimeResult.externalDrivers` — installing `memeloop-k8s`/`memeloop-swarm` and dropping a manifest in `drivers.d` makes the driver reachable. (`d7ef886`) Validation: core 873/873, CLI 370+2 skipped.
6. ~~**Work was done out of phase.** A 2026-07-23 quality audit reopened 24.56 because independent infrastructure-resource placement was not actually complete.~~ **Cleared 2026-07-23:** the audit added production ToolOperation, ModelEndpoint, NetworkAttachment, CredentialGrant, and volume placement/consumption and closed 24.56; Phase 8 may proceed while retaining this history.

**2026-07-23 (quality audit, external routing):** Cleared the scheduler/execution routing gap. `AgentWorkload.spec.placement.orchestrator` and `ToolOperation.spec.placement.orchestrator` explicitly select a registered driver; the local binder skips those resources. The portable `createExternalOrchestrationController` validates health, managed kinds and crash-safe adoption capability, enforces driver `maxConcurrency`, persists driver/native ID/node/diagnostic metadata with CAS, polls native status to terminal state, retries transient failures, resumes persisted placements after restart, and cancels deleted resources. `createNodeRuntime` starts/stops it with discovered drivers. K8s and Swarm now adopt both workload and tool resources by immutable MemeLoop UID (in addition to operation idempotency keys), closing the crash window between native creation and ControlStore status persistence. Validation: core 879/879; CLI 371 passed + 2 explicitly skipped before the final adoption-capability increment and focused discovery/runtime 7/7 after it; K8s 16/16; Swarm 15/15; portable-boundary check and changed-file lint clean; all four production builds pass.

**2026-07-23 (quality audit, runnable external worker):** Added the private `@memeloop/worker-runtime` image package and a bounded, fail-closed entrypoint. The external controller resolves admitted content-addressed script source from the CLI artifact store only at placement time (raw source is not persisted in MemeLoop ControlStore); K8s/Swarm pass the full versioned workload envelope plus source, enforce a 96 KiB inline cap, and accept an explicit `defaultWorkloadImage`. The worker re-normalizes/re-hashes source before execution, requires the admitted async-generator export shape, and runs it in a separate VM realm with string/Wasm code generation disabled, no `process`/`fetch`, and all imports rejected. Host/model/orchestration capabilities fail explicitly; only `memeloop.runtime.health` and `memeloop.runtime.echo` are built-in tool operations. K8s pods disable ServiceAccount automount/service links, privilege escalation, writable root filesystems and Linux capabilities; the bundled worker image runs as `node`, and Swarm applies read-only-root, init and capability-drop hardening (custom executors must declare a non-root `USER`). Kubernetes credentials may be file-backed so tokens do not enter driver manifests. Added missing K8s/Swarm operator READMEs and portable three-part external-driver conformance (capability/health, workload lifecycle+UID adoption, tool lifecycle+UID adoption), executed unchanged against both fake backends. Validation: core 881/881; CLI 371 passed + 2 explicitly skipped; K8s 25/25; Swarm 18/18; worker 5/5; React UI 33/33; K8s/Swarm/core/CLI builds pass. A real local Docker build sent only 16.9 KiB context and both hardened echo and admitted-script container smoke tests completed (`memeloop/worker-runtime:0.0.1`, local image only).

**2026-07-23 (quality audit, durable external results):** Closed the structured result-channel gap. K8s reads the terminal Pod log and Swarm reads the terminal Service log with a 20-line tail and a hard 128 KiB response bound; both parse only a validated final `MEMELOOP_RESULT` record. A native Job/Service success without that record is now a fail-closed execution failure, and contradictory native failure cannot be promoted by worker output. External workloads create/adopt a namespaced durable `AgentRun`, link it from `AgentWorkload.status.runs`, and mirror running/terminal phase, summary and exit code; external tool results and errors are persisted to `ToolOperation.status` after secret redaction. The same audit fixed local workload execution creating `AgentRun` in the default namespace instead of the workload namespace. Fake Kubernetes and Docker servers exercise structured logs and oversized-response rejection. Validation: core 884/884; CLI 371 passed + 2 explicitly skipped; K8s 27/27; Swarm 20/20; worker runtime 5/5; React UI 33/33.

**2026-07-23 (quality audit, real Swarm/K3s acceptance):** Added `scripts/accept-external-driver.mjs`, one backend-neutral acceptance program that creates a real admitted script workload and built-in ToolOperation, waits through the actual driver status/log path, validates the structured result, and removes native resources. It passed against a temporary single-node Docker Swarm and a privileged single-node K3s v1.33.3 container using the locally built worker image. Real K3s exposed two production bugs hidden by fake APIs: symbolic `USER node` is rejected with `runAsNonRoot`, so the image now pins numeric non-root UID/GID `1000:1000`; and `defaultToolImage` was validated but omitted from the tool Pod template, now covered by a no-annotation regression test. Validation: real Swarm workload/tool passed; real K3s workload/tool passed; K8s 28/28, Swarm 20/20, worker runtime 6/6, and both driver builds passed. Temporary cluster, Swarm membership, and credentials were removed. (`ef4cb34`)

**2026-07-23 (quality audit, authenticated worker bootstrap):** Cleared the worker transport gap without exposing `ResourceClient`, provider keys, or a reusable `ModelAccessHandle` to the worker. `createNodeRuntime` owns a persistent 0600 Ed25519 gateway identity and creates a random, short-TTL `WorkerEnrollment` bound to the real AgentRun and workload generation only at external placement time. K8s and Swarm materialize the transient descriptor through native read-only Secrets; token material is absent from workload env, labels, annotations, provider metadata, and ControlStore. Secret creation/deletion is deterministic and crash-aware: retries replace confirmed orphans, adopt live workloads, and never remove a Secret when native creation outcome is uncertain. The worker generates an ephemeral Ed25519 key, proves possession during the one-time exchange, pins and verifies the gateway-signed descriptor, and signs every subsequent scoped request. Profile-only workloads pull their bound assignment and request `runAgent`; admitted scripts receive the same capability through their isolated context. The trusted host executes the child loop through its default ModelGateway-mediated provider, so model credentials and handles remain host-side. CLI `start` exposes explicit public URL/listen/TLS options and rejects plaintext off-loopback. A real end-to-end test uses NodeRuntime, persistent SQLite ControlStore, the HTTP gateway, a separate worker-runtime process, a built-in profile, and ModelGateway, including durable replay rejection after gateway reconstruction. Validation: core 966/966; CLI 397 passed + 2 explicitly skipped; K8s 29/29; Swarm 21/21; worker runtime 7/7; core/CLI production declaration builds and K8s/Swarm type checks pass. (`b719cf2`, `04f3108`, `ec512b7`)

**2026-07-23 (quality audit, publishable private image path):** Added a minimal-permission GHCR workflow for the canonical `ghcr.io/linonetwo/memeloop-worker-runtime` image. Every external Action is pinned to an exact commit; Buildx publishes `linux/amd64` and `linux/arm64`, SBOM and provenance, semantic-version and full-commit tags, and reports the immutable manifest digest. The Dockerfile pins its multi-architecture Node base digest and a local build verified the exact base plus a 31.74 KiB context. Because this repository and its first GHCR package are private, K8s now references namespace-local `imagePullSecrets`, while Swarm re-reads a protected `0400`/`0600` Docker AuthConfig file and sends it only as `X-Registry-Auth`; neither path copies registry credentials into workload state. Validation: K8s 30/30 + type check, Swarm 22/22 + type check, worker 7/7 + syntax check, workflow/README formatting, and local pinned-image build pass. The workflow is committed but has not run remotely, so no registry digest is claimed yet.

**2026-07-23 (real authenticated Swarm/K3s acceptance):** Extended the backend-neutral acceptance to run a real built-in profile through native Secret, isolated non-root worker, private-CA HTTPS, one-time enrollment, signed sequence/replay fence, host `runAgent`, and ModelGateway. It passed on temporary single-node Swarm and K3s v1.33.3 using local image digest `sha256:9ceb8e…`; both reported an Active session at sequence 2 and the expected model result. K3s exposed root-owned Secret `0400` as unreadable by UID 1000; K8s now uses `fsGroup:1000` with `0440`, while Swarm remains UID/GID 1000 mode `0400`. Private PKI CA pinning and a 10 s gateway timeout were added. Core 946, CLI 400+2 skipped, K8s 30, Swarm 22, and worker 7 tests plus all builds passed; clusters, credentials, jobs/services, and Secrets were removed. (`58e4931`)

**Remaining debt (2026-07-23, narrowed):** The same content-addressed image and authenticated profile path now pass on real Swarm and K3s. Only remote publication under the canonical GHCR coordinate and a final rerun using that registry manifest digest remain before this section can close.

**2026-07-26 (published-image release gate):** Added `scripts/accept-external-clusters.mjs`, a reproducible wrapper that refuses to alter an existing Swarm, creates and removes its own single-node Swarm and digest-pinned K3s, provisions a short-lived Bearer-token service account, pins/imports the K3s pause image, and runs the same backend-neutral workload/tool/authenticated-profile acceptance against both real APIs. The external acceptance now accepts a protected Swarm AuthConfig file and creates/removes a namespace-local Kubernetes pull Secret from a protected Docker config; canonical mode fails closed unless the worker coordinate is exactly `ghcr.io/linonetwo/memeloop-worker-runtime@sha256:<digest>`. The GHCR publish workflow now installs Node 24 and pnpm from pinned Actions, builds the four acceptance dependencies, pulls the emitted manifest digest, and must pass this real-cluster gate before the publish job succeeds. Local validation with `memeloop/worker-runtime:0.0.1-auth` passed both backends: workload `Completed`, tool `Completed`, authenticated profile `Completed`, and Active WorkerSession sequence 2; K8s 30/30, Swarm 22/22, and worker runtime 7/7 tests passed. Negative tests rejected a mutable/non-canonical image and missing private-registry credentials. The temporary clusters and resources were removed. **Still open:** this branch has not been pushed and the GHCR workflow has therefore not produced and tested a canonical registry digest; no remote-publication success is claimed.

**2026-07-27 external-evidence check:** Read-only inspection of `ghcr.io/linonetwo/memeloop-worker-runtime:0.0.1` was denied and this host has no GHCR credential; no publication or canonical-manifest acceptance can be claimed without an authorized push/workflow run. Local content-addressed Swarm/K3s evidence remains green.

**2026-07-27 local rerun robustness:** Swarm acceptance passed again. K3s bootstrap was externally blocked because unrelated host K3s workloads exhausted the shared root inotify-instance limit; the runner now reuses already verified digest-pinned bootstrap images instead of requiring a registry HEAD and includes bounded K3s logs on timeout. It cleaned every resource and did not alter the host sysctl or existing clusters. (`13e3455`)

**2026-07-27 publication source hardening:** The canonical GHCR workflow now serializes publication jobs, has a bounded 90-minute timeout, and requires a manual dispatch to name the exact full source commit. A shared fail-closed policy validates that the checked-out `GITHUB_SHA` is that commit, or that an automatic trigger is the exact `worker-runtime-v<package-version>` tag; malformed versions, mutable references, mismatched commits/tags, unknown events, and extra policy fields are rejected. The policy and multi-host acceptance helpers are part of the root unit-test entry point (10/10 focused tests). This strengthens the release gate but does not constitute a remote publication: the branch still needs an authorized push and a successful workflow run before §24.62 can close.

**2026-07-28 quality audit, external effect/runtime authority:** The external controller and both production drivers trusted caller-authored ToolOperation `effect`, arguments, runtime image/command/environment, and workload container annotations. That made a read-effect understatement capable of bypassing host policy as soon as a privileged external tool was added, and let an AgentWorkload replace the trusted worker with an arbitrary container. External drivers now publish mandatory, discovery-validated contracts. A tool contract binds exact kind/name, host-authoritative effect, non-coercing draft-7/2019/2020 input and output schemas, admitted images, and hard CPU/memory ceilings; the bundled image publishes only `memeloop.runtime.health` and `memeloop.runtime.echo`. A workload runtime contract binds `spec.runtimeClass` to host-owned image/command/environment plus default/max CPU and memory. Resource annotations cannot replace those fields, over-limit and unsupported GPU/disk/bandwidth requests fail before backend mutation, and both drivers revalidate before UID/idempotency adoption. The external controller performs the same validation independently, requires host placement/tool policy hooks, persists placement decision or approval evidence before the native effect, and NodeRuntime reuses its durable managed policy/approval authority; trusted workloads are rejected until an independently attested external trusted-node identity exists. External runtime results are output-schema validated before redacted persistence. Discovery rejects drivers that claim a managed kind without its contracts. Negative tests cover effect understatement, malformed input/output, image/command/environment injection, unknown runtime classes, resource escape, absent policy authority, approval evidence, contract-selected default images, and pre-mutation failure in both backends. The formerly stale external acceptance manifest now uses the real `execution.memeloop.io/v1alpha1` ToolOperation schema. Validation: root workspace tests passed (core 1072/1072, CLI 422 passed + 6 environment-gated real-etcd skips, K8s 33/33, Swarm 24/24, worker 7/7, libp2p 23/23, protocol 6/6, UI 33/33, acceptance helpers 10/10); all workspace builds, full lint, and portable-boundary checks passed. Canonical GHCR publication remains the only §24.62 release evidence still open.

**2026-07-28 local real-cluster rerun:** The real-cluster wrapper completed the Swarm workload/tool/authenticated-profile stage with the corrected contracts, then three clean K3s attempts were externally blocked during bootstrap. The captured K3s logs consistently report `inotify_init: too many open files` / `error creating fsnotify watcher` under the host-wide `fs.inotify.max_user_instances=128`, after which K3s exits before image import. No sysctl or unrelated workload was changed, and every temporary Swarm/K3s resource was removed. The wrapper now appends a bounded K3s log tail to any failure before cleanup, so this host-capacity failure is auditable instead of surfacing only as a vanished-container error. This is not claimed as new K3s success; the earlier real K3s evidence remains valid, and the canonical exact-digest workflow must still rerun it on a suitable runner.

**2026-07-28 canonical publication and release-evidence closure:** GitHub Actions run `30342730993` published commit `9e2f32704190f268914b094518652fa06d7d2bfc` as the multi-platform OCI image `ghcr.io/linonetwo/memeloop-worker-runtime@sha256:5b7c0304406ad0d9c6684ae323646da8b6678d3231eefcc64d9ed0060312f388`. The post-publication gate pulled that exact registry manifest and passed real Docker Swarm and temporary K3s workload, ToolOperation, authenticated profile, and active WorkerSession execution; companion CI run `30342726352` also passed. The GHCR package was subsequently made public so Harbor/Xuanyuan can cache it without distributing an upstream credential. Harbor returned the identical OCI index digest, and the three-machine K3s acceptance recorded in §24.64 consumed its approved `library/memeloop-worker-runtime` mirror by the same digest. This supplies the previously missing remote-publication and exact-digest evidence; the historical debt entries above remain for audit context but are closed.

### 24.63 Integrate Electron and other hosts

**Status:** completed
**Completed by model:** GPT-5
**Scope:** intentionally deferred beyond core/CLI.
**Completion criteria:** Electron imports CLI adapters, Tauri passes Rust fixtures, browser uses portable client, and Mobile/edge advertise partial capabilities without duplicating control or Agent state machines.
**Implementation record:** 2026-07-23 — Began host integration only after the Phase 7 quality audit closed. Added the versioned `memeloop.resource.v1` JSON/NDJSON protocol and a browser-safe `RemoteOrchestrationTransport`/`AgentOrchestrationClient` facade. The fetch implementation supports browser, React Native, Electron renderer, and Tauri WebView runtimes; it correlates every response, preserves structured errors, streams watch events with abort propagation, and bounds ordinary bodies and individual watch records. The trusted-side handler binds callers to an already policy-scoped client so the wire protocol cannot select a ControlStore actor. CLI now exports a mountable Node/Electron-main HTTP adapter with mandatory host authorization, exact-path/content-type checks, request-size limits, security headers, NDJSON backpressure, and disconnect cancellation.

The new public `@memeloop/protocol` package exposes this portable boundary, an advisory `PortableResourceCache` contract for independently implemented IndexedDB/native caches, compatibility wire types used by existing hosts, and honest read-only/read-write capability advertisements for remote-only low-power hosts. A dependency-light Rust serde package round-trips the same checked-in golden request/success/failure/watch fixture used by TypeScript tests, establishing the Tauri wire contract without moving controller state machines into Rust. Validation: core 954/954, CLI 390 passed + 2 explicitly skipped, portable protocol 2/2, Rust fixture 1/1, all three TypeScript builds, changed-file lint, and the portable-boundary guard passed. The existing `memeloop-app/apps/mobile` workspace link to the previously missing protocol package now resolves and its TypeScript no-emit check passes. (`60f73f5`)

**2026-07-23 (quality audit, publishable Node SDK):** The `memeloop-cli` package incorrectly pointed `main` at its command-line executable and built no library entry or declarations, so downstream imports only appeared to work against source/workspace artifacts. It now publishes explicit root/auth/runtime/terminal ESM exports and declarations while retaining a separate executable, uses explicit NodeNext import extensions, and externalizes the consuming host's `memeloop` singleton. Declaration generation exposed and fixed a generic `ControllerRunner` resource-filter typing hole, missing core exports, and an SQLite IM-binding migration that discarded the required `createdAt`; the binding now preserves its original creation time across updates. Upgraded the incomplete `zod@3.25.0` package artifact to a valid patch release. A real built-SDK Node import verified `createNodeRuntime`, the HTTP adapter, auth, and terminal entries. Validation: core 954/954, CLI 390 passed + 2 explicitly skipped, both builds with declarations, changed-file lint, and portable-boundary guard passed. (`7e09b5f`)

**2026-07-28 packed-SDK reproducibility correction:** A current-state package audit found that the core `tsup` build never cleaned content-hashed declaration chunks. Repeated development and CI builds had accumulated 1,836 stale files (170 MB) under `dist`, all included by `pnpm pack` despite only 112 files being reachable from the current build. Core builds now clean the output directory before emitting. A permanent pinned-pnpm pack gate inspects all seven public packages, rejects unconverted `workspace:` protocols, missing `main`/types/bin/export targets, more than 250 packed files, or archives over 16 MiB, and imports the built ordinary-peer and NodeRuntime SDK exports. On a clean build, `memeloop` packs 112 files into 2.45 MB and `memeloop-cli` packs 19 files into 0.97 MB; every public package passes. The gate is part of final acceptance, so downstream embeddability is checked against tarballs rather than inferred from workspace imports.

**2026-07-23 (downstream host integration):** `memeloop-app` Mobile now has a remote-only client factory whose bearer token must come from a secure-storage callback; it fails closed when signed out and advertises only read/list/watch resource capabilities instead of claiming local drivers or controller authority. Mobile strict TypeScript passed. (`memeloop-app` `d79a7d0`) Electron now awaits the async CLI Node runtime in its worker, persists runtime/control data under Electron's isolated user-data directory, and mounts the authenticated CLI HTTP adapter on loopback. The main process generates and retains the bearer token; renderer code never receives it. Request and abortable watch operations traverse the existing Electron IPC service into the local HTTP adapter, and the renderer constructs the standard portable `AgentOrchestrationClient` over that IPC transport. Removed references to unpublished `PeerConnectionManager`/`createNodeServer` APIs and made those never-implemented legacy peer calls fail honestly while their replacement is scheduled through declarative resources. The renderer request/watch integration test and formatting checks pass. The downstream full TypeScript check has no errors in the new host path but remains red on pre-existing obsolete cloud-test APIs, prompt-editor exports/form context, and the old `createTaskAgent` bridge; those are tracked as downstream cleanup rather than hidden by this record. (`memeloop-app` `d942ec4`)

**2026-07-23 (portable cache and Tauri bridge):** Added the production browser `createIndexedDatabaseResourceCache`: isolated structured-clone snapshots, kind/API-version/namespace/label queries, resource-version summaries, remove/clear/close lifecycle, and no authoritative write or controller surface. Real IndexedDB transaction semantics are tested with `fake-indexeddb`. Added a dependency-free Tauri WebView invoke transport and client plus a Rust `TauriOrchestrationBridge`: validated request dispatch, state-owned watch iterators, structured command errors, completion/explicit-close cleanup, shared command constants, and application-owned authenticated backend binding. The Tauri application needs only four thin command wrappers and does not duplicate resource state machines. TypeScript protocol 6/6 and Rust fixture/bridge 2/2 pass; the TypeScript build with declarations passes. (`e3e789f`, `cb547e0`)

**2026-07-23 (cross-host acceptance and closure):** Added `scripts/accept-host-integration.mjs`, which uses the built core, CLI SDK, protocol package, a real loopback HTTP server, persistent SQLite ControlStore, and IndexedDB cache. It proves missing authentication is denied, apply produces an NDJSON watch event, consumer disconnect cancels the underlying response stream, the cached snapshot remains available offline, restart/reconnect preserves the resource UID, and remote delete plus cache invalidation converge. The first run exposed a response-stream leak when an async-iterator consumer returned between watch events; the fetch transport now cancels unfinished readers and has a dedicated regression test. Acceptance passed with all five evidence flags; core 955/955, CLI 390 passed + 2 explicitly skipped, protocol 6/6, Rust 2/2, all builds, changed-file lint, and portable-boundary checks pass. (`d71131f`) The §24.63 completion criteria are now met.

**2026-07-23 (real Desktop/React Native package acceptance):** The extracted adapter still was not consumable by both real downstream hosts: Electron imported concrete libp2p values from portable `memeloop`; the adapter shipped Node TCP/mDNS in every graph and retained `memeloop` as a raw workspace dependency; Metro consequently reached Node `net`, `dgram`, and `os`, and the full core entry exposed an unsupported variable dynamic import. `@memeloop/libp2p` now keeps a Node/Electron root entry and a separately pre-bundled, tree-shaken `/browser` entry using WebSocket/circuit relay only; `memeloop` is a runtime peer, while focused `memeloop/device-network` and `memeloop/mobile` entries keep device sync and the direct agent/tool loop out of host-only script-loader graphs. Package tests now bundle both browser graphs without Node built-ins, and packed-manifest inspection verifies the peer and all required generated files. `TidGi-Desktop` consumes the Node entry and its full TypeScript check passes. `TidGi-Mobile` consumes `/browser` and `/mobile`; its strict TypeScript and changed-file lint pass, and a real Expo Android export completed all 2,570 modules and emitted a 9.18 MB Hermes bundle. Core 946/946, CLI 400 passed + 5 environment-gated skips, and adapter 22/22 plus browser-bundle checks pass. (`11c92e9`)

**Residual downstream follow-up:** `memeloop-app` still contains obsolete cloud/peer test fixtures, prompt-editor/form typing failures, and an old `createTaskAgent` bridge, and product UI still needs an authenticated pairing flow before Mobile may connect to a non-loopback Desktop endpoint. The separate `TidGi-Desktop` and `TidGi-Mobile` package/build compatibility gaps are now closed. The remaining `memeloop-app` paths must be cleaned before final downstream release acceptance.

**2026-07-26 (Electron 43 / Node 24 UtilityProcess integration audit):** Replayed the latest relevant `tiddly-gittly/TidGi-Desktop` master changes into `memeloop-app/apps/desktop`, including the Git and Wiki migration from in-process/worker-thread execution to Electron `UtilityProcess`, without discarding MemeLoop's host bridge. The packaged runtime now uses Electron 43.2.0 (embedded Node 24.18.0), requires host Node 24+, and pins `better-sqlite3` 13.0.1. Packaging copies either the locally compiled addon or the package's N-API prebuild layout, unpacks complete Vite UtilityProcess chunk graphs, preserves native/libp2p dependencies outside ASAR, and emits the remaining MemeLoop Agent worker through a CJS-safe local Vite plugin. A same-filesystem packager staging directory removes a reproducible Node 24 cross-device copy race over the large TiddlyWiki tree.

The audit restored the Add/Edit Workspace and generic Preferences routes that were lost in the earlier downstream merge, retained the remote orchestration windows, and fixed two runtime races found by the real checkpoint flow: opening Git history now reuses the window for the same workspace, and the browser IPC sync path both reconnects after a Wiki UtilityProcess restart and retains change notifications until TiddlyWiki's asynchronously queued Syncer task consumes them. This makes a Git checkpoint restore converge on disk, in the Wiki worker, and in the rendered browser view instead of only appearing successful in storage. Validation on the packaged Linux application: TypeScript no-emit passed; 58 unit-test files passed with 469 tests and 8 explicit skips; checkpoint create/restore E2E passed 44/44 steps; cross-window/restarted-worker SSE E2E passed 17/17; launch, Agent worker, Wiki UtilityProcess, Preferences, and logging smoke passed 10/10. The integration is committed in `memeloop-app` as `fc1a2210` after upstream replay commits `4794313f`, `3d013d45`, and `e41440c9`; no remote push was performed. The obsolete Desktop type/test debt named above is therefore closed. **Remaining product follow-up:** expose an authenticated non-loopback pairing flow before Mobile is offered as a remote Desktop client; this is a product onboarding/auth surface, not a duplicated orchestration state machine.

**2026-07-26 (authenticated Desktop↔Mobile pairing closure):** Replaced the remaining demo-only Mobile node screen with a real mutually approved device flow. Desktop creates a bounded five-minute invitation containing only its peer identity and WebSocket multiaddrs; it contains no bearer or reusable secret. Mobile creates a persistent Ed25519 device identity, stores the private seed and per-peer trust/address records in Expo SecureStore, dials the invitation over libp2p Noise, and both devices must independently accept the same transcript-derived six-digit code. Persisted direct addresses restore dialing after Mobile restart; either side can reject or forget trust.

The paired stream now carries the versioned JSON/NDJSON orchestration protocol directly over `/memeloop/orchestration/1.0.0`. Desktop keeps its random worker HTTP bearer entirely inside the Electron main process and adapts that private transport to the standard client. Its peer handler applies an enforcement boundary, not only capability advertising: Mobile is limited to `get`, `list`, and `watch` for `AgentDefinition`, `AgentWorkload`, `AgentRun`, `LoopRun`, and `ToolOperation`; mutations and other resource kinds fail before reaching the worker. The Mobile UI can verify the live orchestration capabilities over the encrypted peer stream. A final downgrade audit found that the obsolete Desktop `confirmPeerPin` path had never verified possession of a remote key and persisted the entered display code as if it were a static public key. The compatibility API now fails closed without touching trust state, and its misleading PIN UI has been removed (`memeloop-app` `2eaddf3c`, focused 13/13 tests).

Real Expo packaging exposed two issues that TypeScript alone had missed. The `memeloop/device-network` entry still pulled host-only deployable-script code into Metro, and the package root did not select its browser graph for React Native. The focused device-network entry is now explicitly portable, separate portable device/orchestration exports are published, and the root has a `react-native` export condition. Mobile also has an explicit sibling-workspace Metro configuration and a functioning ESLint setup. Validation: core 120 files/955 tests; libp2p 23/23 including real Noise pairing/orchestration E2E plus the browser no-Node-builtins check; protocol 6/6; Desktop 59 files/471 tests with 8 explicit skips, TypeScript, and changed-file lint; Mobile strict TypeScript and lint; and a real Expo Android/Hermes export of 1,111 modules (4.5 MB). Core commits: `08380ae`, `3f002fd`, `bd3140c`; downstream commits: `fbc8e3eb`, `a93c5355`. No remote push was performed. The authenticated Mobile pairing residual is closed.

**2026-07-27 (latest TidGi Desktop UtilityProcess rebase and stream audit):** Rebasing the real `TidGi-Desktop` integration branch onto upstream master `3488e972` replayed 162 MemeLoop commits while preserving the upstream Git worker migration to `vite-plugin-electron-utility-process` and Electron `UtilityProcess`. The resulting package uses Electron 43.2.0 with embedded Node 24.18.0 and `better-sqlite3` 13.0.1; a frozen offline install succeeds, the native addon loads against SQLite 3.53.3, and the packaged ASAR contains the generated UtilityProcess worker graph. The audit also corrected an upstream package/lock mismatch: at that checkpoint `package.json` selected the then-required AI SDK 4 dependency family while the inherited lock still described AI SDK 7; the regenerated lock followed the declared local MemeLoop package graph. The later provider-path correction in §24.65 upgrades both MemeLoop and this host coherently to AI SDK 7.

The rebase exposed one real integration defect: the core consumed every provider chunk but only the final immutable message reached Desktop observers. `AgentFrameworkContext.onTransientMessage` now delivers cumulative UI-only messages under the final message ID, isolates subscriber failure so a closed renderer cannot abort final persistence, and retains append-only storage semantics. Desktop replaces only that transient ID in its observable view. Tests prove intermediate observer delivery, stable identity, one final persisted assistant message, and subscriber-failure isolation. Canonical multi-system-message prompt assertions and selectors were updated for the current agent/template/preferences forms rather than weakening E2E expectations. Validation: core lint, 143 files/1047 tests, focused 9/9 streaming tests, and production/declaration build pass; Desktop frozen offline install, TypeScript, lint, 72 files/510 tests with 3 explicit skips, Electron packaging, and the complete packaged E2E suite pass at 71/71 scenarios and 1860/1860 steps. Commits: core `0509c5a`; downstream `e98c4ea0`. No remote push was performed.

**2026-07-26 CLI game-development tooling correction:** The CLI advertised `lsp.*` as an allowed read-only capability for explore/oracle agents, but every operation was an explicit grep-based stub that returned `TODO` text while appearing successful. It now speaks framed JSON-RPC 2.0 to real language servers over stdio: initialize/initialized, bounded document open, definition, references, hover, document symbols, workspace symbols, shutdown, server-request replies, errors, timeouts, process cleanup, and response truncation are implemented. Executables are selected from a fixed extension allowlist, so LSP authority cannot be converted into arbitrary command execution. TypeScript/JavaScript works out of the box through the runtime `typescript-language-server` 5.3.0 and TypeScript 5.9.3 dependencies; Python, Rust, Go, C/C++, and Lua use their standard installed servers and fail honestly when absent. A real TypeScript language-server integration test proves symbol discovery and tests cover unsupported languages and missing-server failure. CLI full regression passes 410 tests with 5 explicit environment-gated skips; the Node 24 production build with declarations and changed-file lint pass.

**2026-07-28 public-package release preparation and CI correction:** The release audit found that the only repository CI workflow still selected the deleted `memeloop-node` workspace. Even if corrected to `memeloop-cli`, its Cucumber command loaded CommonJS configuration inside an ESM package and then referenced the removed WebSocket manager, global skill registry, and pre-canonical `ChatMessage` shape; all 116 steps were therefore either unreachable or for an architecture that no longer exists. The misleading suite and its Cucumber/ts-node development dependencies were removed. `test:e2e` now executes 23 current production-boundary tests: real TCP HTTP adapters, two real TCP/Noise/libp2p peers, the signed worker gateway, durable ToolOperation, and NodeRuntime scheduling through process isolation, model, network, storage, and replication paths. CI now uses Node 24 and pnpm 9.0.0 from commit-pinned Actions, has a timeout, and runs build, all unit tests, lint, portable boundaries, packed-manifest validation, and the current E2E.

The seven public packages are release-aligned at `0.1.0`; internal runtime and peer ranges resolve to the same version while the independently versioned private worker image remains `0.0.1`. Registry inspection found only `memeloop@0.0.1`, `memeloop-cli@0.0.1`, and `@memeloop/react-ui@0.0.2`; libp2p, protocol, K8s, and Swarm have no published coordinate yet. Frozen offline install passed. All production/declaration builds, 1089 core tests, 428 CLI tests with six explicit real-etcd gates, 23 production-boundary E2E tests, K8s 33, Swarm 24, libp2p 23 plus browser bundle, protocol 6, React UI 33, worker 7, lint, boundaries, and all seven `pnpm pack` checks passed at version `0.1.0`. Publication is not claimed until npm authentication and remote push complete.

### 24.64 Run final adversarial and fleet acceptance

**Status:** completed
**Scope:** complete system.
**Completion criteria:** Portability, package, controller, scheduler, runtime, model, tool, network, storage, credential, artifact, hostile-worker, promotion, quorum, and hundred-node fleet suites all pass with documented RPO/RTO and residual risks.
**Implementation record:** 2026-07-23 — Added `scripts/accept-final-orchestration.mjs`, a fail-fast bounded acceptance runner covering portable-boundary enforcement; production builds; full core, CLI, K8s, Swarm, worker, browser protocol, and Rust/Tauri suites; real HTTP/SQLite/IndexedDB host disconnect/reconnect; acknowledged-write crash recovery; and a real hardened container fleet. The first run passed every component suite. After a child process acknowledged a SQLite ControlStore transaction, the runner sent `SIGKILL`; reopening preserved the write (observed RPO: zero acknowledged writes) in 326 ms against a 5 s RTO target. SQLite now explicitly uses WAL + `synchronous=FULL` for acknowledged orchestration decisions. One hundred non-root, read-only, no-network, capability-dropped worker containers ran `memeloop.runtime.health` at concurrency 25 in 3.633 s wall time, with 1.013 s per-worker P95; the existing portable fleet suite separately drove 150/200-node controller, quorum, rollout, budget, drift, and security-threshold paths. All listed completion-criterion suites are represented and passed locally.

**Residual risks found by the first acceptance run:** (1) the quorum implementation is still the portable in-process adapter, not a real multi-host etcd availability drill; (2) the hundred-worker run uses one 12-CPU Docker host, not one hundred physical machines/fault domains; (3) local process RuntimeClasses lacked hard OS isolation; (4) published-image authenticated Swarm/K3s acceptance awaits the GHCR workflow. The same audit exposed that the old portable-boundary checker ignored dependency metadata. The package and local-runtime findings are cleared below; the real multi-host and published-image drills remain open.

**2026-07-23 package criterion correction:** The package-boundary gap is closed by `@memeloop/libp2p`, optional provider peers, browser-safe binary decoding, manifest-aware CI enforcement, and final-acceptance coverage for the extracted adapter. Frozen root/nested installs, production builds, full core/CLI/adapter suites, and actual `pnpm pack` manifest inspection passed. Runtime isolation and published-image real-cluster drills remain open. (`ca3f9ca`)

**2026-07-23 local-runtime criterion correction:** The Linux process path now has measured cgroup CPU/RSS/swap/task limits, namespace/filesystem isolation, no-new-privileges, seccomp, and blocked direct egress for non-full classes; failure to prepare removes the classes from scheduling instead of weakening them. Current residual risks are the single-host nature of the local fleet, a real multi-host quorum drill, and the published-image authenticated Swarm/K3s drill. (`c71c1b7`)

**Post-correction rerun:** Every final-acceptance component passed with the real Linux sandbox included; crash recovery remained RPO 0/RTO 326 ms, and 100 hardened containers completed in 3.587 s with 980 ms P95. (`c71c1b7`)

**2026-07-23 external-runtime correction:** Real Swarm and K3s now pass workload, tool, and authenticated profile execution over private-CA HTTPS using the same local image digest; the run also found and fixed K8s non-root Secret ownership. The external residual is now only publication and rerun by canonical GHCR manifest digest. (`58e4931`)

**2026-07-23 quorum correction:** The former portable quorum simulation has been replaced for production use by the authenticated etcd adapter and a real 1→3 learner/promotion, leader-loss, quorum-loss, recovery, fencing, and snapshot drill; `scripts/accept-final-orchestration.mjs` now runs that drill. The quorum residual is closed. Remaining documented release risks are (1) the 100-worker container fleet still represents processes on one physical Docker fault domain, not 100 machines, and (2) the worker image still needs publication plus authenticated Swarm/K3s rerun by its canonical GHCR manifest digest. (`a8c50c4`)

**2026-07-23 downstream package correction:** The final package criterion now includes a real React Native consumer rather than only an abstract browser bundle. The Node and browser libp2p entries, focused mobile core graph, exact packed artifact, Electron TypeScript consumer, and Expo Android production export all pass as recorded in §24.63. The two remaining acceptance risks are unchanged: the local hundred-worker fleet is one physical fault domain, and the canonical GHCR image has not yet been published and rerun by manifest digest. (`11c92e9`)

**2026-07-26 release-gate correction:** A fresh `scripts/accept-final-orchestration.mjs` run passed every component, host, real-etcd, crash, and fleet suite. The acknowledged SQLite crash remained RPO 0 with 416 ms RTO against the 5 s target; 100 hardened worker containers at concurrency 25 completed in 4.144 s with 1.184 s P95. The runner's stale residual text was corrected: its etcd evidence is a real three-member drill on one Docker host, not the former in-process adapter. A new post-publication workflow gate now recreates real Swarm and K3s and requires workload, tool, authenticated profile, and WorkerSession success using the exact canonical GHCR manifest digest. The same gate passed locally with the content-addressed development image. **Remaining release evidence:** the GHCR job itself cannot run until the committed branch is pushed; the hundred-container test and the three-member etcd test also remain single-physical-host evidence rather than a separate-machine fault-domain drill.

**2026-07-27 final local rerun:** The complete acceptance runner passed all component/build/host/Tauri suites and the real three-member etcd drill; acknowledged SQLite recovery remained RPO 0 with 436 ms RTO, and 100 hardened containers at concurrency 25 completed in 4.480 s with 1.289 s P95. Remaining evidence is external only: canonical GHCR publication/Swarm/K3s rerun and separate-machine fault domains.

**2026-07-27 physical-fault-domain gate implementation:** Added a schema-validated SSH inventory and two bounded, privacy-preserving acceptance programs. The fleet program requires the canonical GHCR manifest digest, distributes at least 100 hardened workers over at least three operator-declared fault domains, rejects duplicate SSH endpoints plus aliased raw machine/boot identities, supports heterogeneous amd64/arm64 hosts, and probes every surviving host after each single-host exclusion. The etcd program requires exactly three independently identified Linux hosts with mutually reachable advertise addresses, generates one-day per-run mTLS credentials, starts one real etcd 3.6.11 voter per host, and verifies acknowledged writes before failure, continued writes after the voter on one host stops, `UNAVAILABLE` after a second voter stops, recovery without acknowledged-write loss, fencing-epoch advancement, and a real snapshot. Machine/boot IDs reject obvious aliases but cannot prove physical tenancy, so the inventory owner remains responsible for attesting that the three labels are independent physical failure domains. Secrets, SSH targets, addresses, and raw host identities are omitted from evidence; cleanup is limited to the random run-scoped containers and certificate directories.

`MEMELOOP_ACCEPTANCE_MULTI_HOST_INVENTORY` now makes both programs mandatory in `scripts/accept-final-orchestration.mjs`; the runner removes the two single-host residuals only after both pass. Node syntax checks, formatting, portable-boundary checks, the new 10/10 acceptance-tool tests (including a fake-SSH fleet protocol run), and the complete workspace unit suite pass. This records implementation readiness only: no separate-machine inventory is available in the current environment, so no physical-fault-domain success is claimed and §24.64 remains in progress. Canonical GHCR publication and the exact-digest Swarm/K3s workflow remain the other external release evidence.

**2026-07-27 AI SDK 7 compatibility rerun:** After the provider-path and managed-tool schema corrections recorded in §24.65, the exact final worktree passed the complete acceptance runner again: every build, component suite, portable boundary, Tauri suite, host reconnect test, and real three-member etcd drill passed. Acknowledged SQLite recovery remained RPO 0 with 428 ms RTO against the 5 s target; 100 hardened workers at concurrency 25 completed in 4.406 s with 1.225 s P95. The remaining release evidence is unchanged and external: an operator-supplied separate-machine inventory plus canonical GHCR publication and authenticated Swarm/K3s rerun by manifest digest.

**2026-07-27 complete host-tool catalog rerun:** After the default-tool schema coverage and per-runtime isolation correction in §24.61, the exact final worktree passed the complete acceptance runner. All production builds, component suites, portable boundaries, Tauri/host acceptance, and the real three-member etcd drill passed. Acknowledged SQLite recovery remained RPO 0 with 434 ms RTO against the 5 s target; 100 hardened workers at concurrency 25 completed in 4.350 s with 1.180 s P95. Remaining evidence is still external only: a supplied separate-machine inventory and canonical GHCR publication plus the authenticated Swarm/K3s exact-digest rerun.

**2026-07-28 external-authority rerun:** After the external ToolOperation and AgentWorkload authority correction in §24.62, the exact worktree passed the complete final acceptance runner again. All production/declaration builds, component suites, portable boundaries, Tauri/host acceptance, and the real three-member etcd drill passed. Acknowledged SQLite recovery remained RPO 0 with 436 ms RTO against the 5 s target; 100 non-root, read-only, no-network, capability-dropped workers at concurrency 25 completed in 4.351 s with 1.209 s P95. The remaining evidence is unchanged and external: canonical GHCR publication plus authenticated Swarm/K3s rerun by exact manifest digest, and an operator-supplied separate-machine inventory for physical fault domains.

**2026-07-28 credential-persistence rerun:** After binding credential fencing, idempotency, and target-materialization revocation metadata to durable host state, the exact worktree passed the complete final acceptance runner. Every build, component suite, portable boundary, Tauri/host acceptance, and the real three-member etcd drill passed. Acknowledged SQLite recovery remained RPO 0 with 435 ms RTO; 100 isolated workers at concurrency 25 completed in 4.455 s with 1.277 s P95. The remaining evidence is unchanged and external: canonical GHCR publication plus authenticated Swarm/K3s rerun by exact manifest digest, and an operator-supplied separate-machine inventory for physical fault domains.

**2026-07-28 replicated-storage authority rerun:** After replacing the false ControlStore-only primary fence with the real host transport fence, adding NodeRuntime replica-controller routing, enforcing StorageClass capability promises at binding and pre-effect, validating managed native/adopted provision results, and eliminating unchanged-status self-trigger loops, the exact worktree passed the complete acceptance runner. Workspace evidence is core 1078/1078, CLI 423 passed with six explicit real-etcd environment skips, K8s 33/33, Swarm 24/24, libp2p 23/23, protocol 6/6, React UI 33/33, and worker 7/7; full lint and portable boundaries pass. The first parallel workspace run also exposed a test-only credential lifecycle race (vault deletion precedes the later observable `Revoked` status CAS); its E2E now waits for both states and passed three isolated repetitions plus the full rerun. Final acceptance passed all builds, component/host/Tauri suites, and the three-member etcd drill. Acknowledged SQLite recovery remained RPO 0 with 461 ms RTO against the 5 s target; 100 isolated workers at concurrency 25 completed in 4.335 s with 1.186 s P95. Remaining release evidence is still external: canonical GHCR publication and authenticated Swarm/K3s exact-digest rerun, plus an operator-supplied separate-machine inventory for physical fault domains.

**2026-07-28 mutable-volume snapshot rerun:** After binding replication to an immutable fenced-primary snapshot rather than a live source path or stale permanent hash, the exact worktree passed all workspace tests (core 1081/1081; CLI 423 with six explicit real-etcd environment skips; K8s 33/33; Swarm 24/24; libp2p 23/23; protocol 6/6; React UI 33/33; worker 7/7), full lint, and portable boundaries. Final acceptance passed every production build, component/host/Tauri suite, and the three-member etcd drill. Acknowledged SQLite recovery remained RPO 0 with 440 ms RTO against the 5 s target; 100 isolated workers at concurrency 25 completed in 4.621 s with 1.313 s P95. Remaining external evidence is unchanged.

**2026-07-28 ordinary-peer production-routing rerun:** After replacing §24.58's helper-only completion claim with the real authenticated CLI production route, the exact worktree passed all workspace tests (core 1086/1086; CLI 427 with six explicit real-etcd environment skips; K8s 33/33; Swarm 24/24; libp2p 23/23; protocol 6/6; React UI 33/33; worker 7/7), full lint, every production/declaration build, and portable boundaries. The focused cross-node test additionally uses two real TCP/Noise libp2p nodes and a real QuorumControlStore to prove unpaired denial, mutual pairing, namespace-bound submit/status/cancel, and durable state isolation. Final acceptance passed every build, component/host/Tauri suite, and the real three-member etcd drill. Acknowledged SQLite recovery remained RPO 0 with 443 ms RTO against the 5 s target; 100 isolated workers at concurrency 25 completed in 4.454 s with 1.373 s P95. Remaining release evidence is unchanged and external: canonical GHCR publication plus authenticated Swarm/K3s exact-digest acceptance, and an operator-supplied separate-machine inventory for physical fault domains.

**2026-07-28 peer-Run and packed-SDK adversarial rerun:** After denying remote mutation of controller-owned `AgentRun`, validating deterministic Run adoption independently inside the workload controller, publishing the per-kind operation matrix, and making packed output reproducible, the exact worktree passed core 1089/1089, CLI 428 with six explicit real-etcd gates, K8s 33/33, Swarm 24/24, libp2p 23/23, protocol 6/6, React UI 33/33, and worker 7/7. Full lint, portable boundaries, production/declaration builds, and all seven pnpm-packed public manifests passed; current core and CLI archives contain 112/19 files and are 2.45/0.97 MB. Final acceptance includes the new pack gate and passed every component, host/Tauri path, and real three-member etcd drill. Acknowledged SQLite recovery remained RPO 0 with 459 ms RTO; 100 isolated workers at concurrency 25 completed in 4.550 s with 1.274 s P95. Remaining evidence is external only: canonical GHCR publication plus authenticated Swarm/K3s exact-digest acceptance, and an operator-supplied separate-machine inventory.

**2026-07-28 release-CI audit:** Replacing the dead `memeloop-node`/Cucumber job with current production-boundary E2E exposed and removed a false CI signal rather than weakening it. The exact release-preparation worktree passed frozen installation, every workspace build, all component tests, the new 23-test production E2E, full lint, portable boundaries, and seven packed packages at `0.1.0`. The two remaining release-evidence requirements are unchanged: the authorized remote push/GHCR exact-digest workflow and a supplied independent-machine inventory.

**2026-07-28 K3s physical-fault-domain backend and real quorum evidence:** The SSH-only gate could not use the operator-authorized K3s cluster without separately provisioning SSH and Docker on every node. Added a strict version-2 Kubernetes inventory and first-class fleet/quorum runners while retaining the version-1 SSH protocol unchanged. The fleet runner resolves and de-aliases Node machine/boot identities, requires Ready nodes and exact hostname labels, distributes at least 100 digest-pinned restricted Pods over three declared physical fault domains, validates every result, and performs fresh probes on all non-excluded nodes for each single-node exclusion. The quorum runner creates three node-pinned, PVC-backed etcd 3.6.11 voters with one-day mutual TLS, verifies a write with all voters, a write after one voter is stopped, `UNAVAILABLE` after a second voter is stopped, durable recovery, acknowledged-write retention, fencing-epoch advancement, and a real snapshot. Both use random namespaces, omit addresses/raw identities/key material from evidence, and clean only their labeled namespace; storage class and a bounded `kubectl` executable prefix are explicit operator inputs.

The real quorum drill passed against independent K3s nodes `versetensor-hv`, `sansheng-hv`, and `westlake`: all three voters became healthy; the post-single-loss write committed at resource version 3; loss of the second voter rejected writes; recovery committed resource version 4; both acknowledged writes remained; the fence advanced from epoch 1 to 2; and the snapshot completed at resource version 6. The first probe also correctly exposed that the cluster's default Longhorn class and `haixia` local-path provisioning were unsuitable for this bounded drill; the runner now defaults explicitly to the node-local `local-path` class and permits an operator override rather than silently depending on a cluster default. Twelve acceptance-tool tests, syntax, formatting, and diff checks pass. This closes the real multi-machine quorum residual. The 100-worker Kubernetes fleet still requires the canonical GHCR manifest digest, so §24.64 remains in progress until the authorized push publishes that image and the exact-digest fleet/authenticated profile workflows pass.

**2026-07-27 bound tool-input enforcement rerun:** The exact final worktree with trusted Invoke schema enforcement passed the complete acceptance runner again. Every production build, component suite, portable boundary, Tauri/host acceptance, and real three-member etcd drill passed. Acknowledged SQLite recovery remained RPO 0 with 447 ms RTO; 100 hardened workers at concurrency 25 completed in 4.434 s with 1.234 s P95. The external release evidence remains unchanged.

**2026-07-27 tool-permission parity rerun:** After aligning lookup and catalog permission semantics, the exact final worktree again passed every final-acceptance build, component, boundary, Tauri/host, real-etcd, crash, and fleet gate. Acknowledged SQLite recovery remained RPO 0 with 442 ms RTO; 100 hardened workers at concurrency 25 completed in 4.404 s with 1.233 s P95. External release evidence remains unchanged.

**2026-07-27 host-authoritative tool-effect rerun:** After removing caller-selectable fabricated effects, the exact final worktree passed every final-acceptance gate, including all builds/components, portable boundaries, Tauri/host acceptance, and the real three-member etcd drill. Acknowledged SQLite recovery remained RPO 0 with 450 ms RTO; 100 hardened workers at concurrency 25 completed in 4.427 s with 1.211 s P95. External release evidence remains unchanged.

**2026-07-28 Harbor-backed three-machine fleet closure:** The published OCI index was cached through the cluster's single Harbor entry and copied to the approved private coordinate `harbor.k3s.onetwo.website/library/memeloop-worker-runtime@sha256:5b7c0304406ad0d9c6684ae323646da8b6678d3231eefcc64d9ed0060312f388`; Harbor's manifest response retained the exact canonical GHCR digest. The Kubernetes fleet runner was tightened to accept only that fixed Harbor mirror or the fixed GHCR source, always digest-pinned, and to accept Kubernetes 1.36's generic `kind: List` Pod response in addition to `PodList`; tags, arbitrary registries, and other Harbor projects remain rejected. Focused acceptance tests cover both corrections.

The real version-2 inventory run completed 100 restricted Worker Pods over three independent physical K3s nodes/fault domains: 34 on `versetensor-hv`, 33 on `sansheng-hv`, and 33 on `westlake`. Every Pod ran non-root with RuntimeDefault seccomp, a read-only root filesystem, no service-account token, no privilege escalation, all capabilities dropped, and bounded CPU/memory, then returned the exact healthy structured result. Wall time was 435,384 ms, including bounded controller-to-cluster evidence collection. Fresh probes succeeded on every surviving node after separately excluding each of the three nodes, proving two remaining fault domains for every single-machine loss. Evidence contains only SHA-256 machine/boot identity digests; raw identities, registry credentials, and addresses were excluded, and all run-scoped namespaces and Secrets were deleted. Together with the earlier three-voter etcd quorum/loss/recovery/fencing/snapshot drill and the canonical Swarm/K3s publication gate, this closes the final external evidence residual and §24.64.

**2026-07-30 general-agent reliability and host-integration audit:** Real TidGi Desktop sessions were exercised against seven configured SiliconFlow models on one identical multi-step task: persist a goal, create a Wiki note, read it back by exact title, and report only verified completion. DeepSeek V4 Flash, DeepSeek V4 Pro, Kimi K2.6, GLM 5.2, DeepSeek V3.2, and Qwen 3.5 9B completed with durable Wiki and plan evidence; Qwen 3.5 27B produced no first token for four minutes and was cancelled. The default general-assistant profile is upgraded to version 1.1.0 with explicit goal tracking, exact tool/schema discipline, Wiki filter examples, post-write verification, UI inspection, and honest completion rules. Desktop's real `todo` host tool is configured while the portable built-in todo plugin remains available for core hosts.

The audit also corrected three runtime defects rather than treating prompt tuning as a substitute for enforcement. Prompt plugins now receive the live current-agent context, allowing persistent host plans to be injected on later turns. Malformed XML tool JSON is represented as an explicit parse error and is never reinterpreted as a permissive `input` argument. Legacy plugin-driven tools now share a persisted repeated-call guard: the third identical call is rejected and the run stops as blocked instead of consuming an unbounded model/tool loop. Core validation passed 144 files and 1,092 tests, lint, production/declaration build, portable-boundary checks, and packed-package inspection; the release candidate packs 112 files in approximately 2.47 MB. The corresponding host work adds bounded AI and MCP calls, modern Streamable HTTP MCP support, durable todo parsing, invalid Wiki-filter rejection, bundled-agent upgrade semantics, and terminal subscription cleanup; its downstream validation and PR evidence are recorded with the release commits rather than claimed here.

**2026-07-30 Windows production-startup evidence:** The installed PR package's Squirrel logs prove that installation, self-update, and both shortcuts completed successfully; the application log instead fails while synchronizing the pre-MemeLoop `agent_instance_messages` table because historical rows lack the new non-null `messageId`. Desktop commit `3251fc16` adds a bounded, idempotent pre-synchronization migration. A read-only copy of the actual failing Windows `agent-cache.db` was migrated locally and then synchronized through the complete current Agent entity set: every historical message survived byte-for-byte by SHA-256 digest, every canonical identity/timestamp/Lamport field was populated, and no remote production data was modified. Final installed-package startup evidence awaits the next Windows artifact containing this commit.

**2026-07-30 fresh-install product-policy correction:** The migration above is deliberately not part of the release. The product has not yet admitted stable end users, and the supported contract begins with a fresh database at the current schema. Carrying an unneeded historical-data path would add startup authority and test surface without a real compatibility obligation. The Desktop integration branch was rebased without the migration commit and contains no legacy `agent_instance_messages` migration. This note supersedes only the proposed compatibility action; the original failure evidence remains in the audit trail.

### 24.65 Implement the ModelGateway trusted model path

**Status:** completed
**Completed by model:** Kimi K3
**Scope:** plan §12 — gateway validation, budget enforcement, audit, revocation.
**Completion criteria:** The gateway verifies Run/model/audience/budget/expiry and proof-of-possession per call, enforces per-Run token/cost/concurrency/request-rate budgets at the gateway (§12.4), records ModelCallRecords without secrets, and revokes access on Run completion/cancellation (§12.1 step 6, §21.3).
**Implementation record:** 2026-07-23 — Core `drivers/modelGateway.ts`: `createModelGateway` guards a host executor with 24.34 handles: per-call signature/audience/expiry verification, PoP gap closed (key-bound handles require the presented key), model/digest binding, sliding-window request-rate, concurrency budget, mid-stream usage-metered token/cost budget aborts (EXHAUSTED via executor cancel), `maxOutputTokens` clamped to the handle budget, per-call ModelCallRecord (identity/policy/usage/latency only — never tokens/prompts/output; recorder failures reported via `onError`, never break calls), `cancel`/`revokeHandle`/`revokeRunHandles` (aborts in-flight, rejects later use). CLI `orchestration/nodeModelGateway.ts`: HMAC-SHA256 signer with 0600 host-persisted broker key, ControlStore ModelCallRecord recorder (idempotent by callId, CAS status), `createNodeModelGateway`; `createNodeRuntime` wires it by default with dataDir + ControlStore (`modelGateway.enabled=false` opts out), exposed as `NodeRuntimeResult.modelGateway` (gateway + broker + issueHandle). Validation: core 868/868 (14 gateway tests), CLI 361+2 skipped (signer, key persistence, nodeRuntime end-to-end: issue → generate → audited record → forged-token rejection → Run revocation). (`3df6a7e`) **Deferred:** the worker-side transport (authenticated local channel / bootstrap descriptor per §12.4) and routing loop model calls through the gateway by default remain 24.35 debt.

**2026-07-23 deferred transport cleared (GPT-5):** Default loop routing was completed in `4a433fd`; authenticated local/external worker capability transport is completed in `04f3108`/`ec512b7` and described under 24.35/24.62. External workers invoke the trusted host's gateway-mediated child loop instead of receiving provider keys or a reusable handle. The end-to-end external-profile test verifies that this path reaches the ModelGateway-backed provider and persists its durable worker replay fence.

**2026-07-26 Run-binding quality correction:** The prior default-routing claim was incomplete for an independently scheduled local `ModelEndpoint`: NodeRuntime reused its global gateway-mediated provider, so per-call handles had no `runRef`, attempt, or policy digest even though the gateway supported those claims. The local in-process runtime now resolves a fresh gateway provider from the exact fenced endpoint and AgentRun. Every issued handle is bound to the Run API/kind/name/UID, immutable attempt, endpoint/model selection, a canonical digest of the workload model policy plus endpoint resource version/data policy, and the tighter intersection of daemon and workload output/cost budgets. The broker rejects partial Run identities, missing UID/attempt, attempt-without-Run, and non-positive attempts before signing. `ModelCallRecord` now retains the non-secret policy digest and attempt alongside its Run reference, usage, and handle ID.

The old NodeRuntime “model binding” test only stopped after placement and used a profile ID that did not exist, so it supplied no model-call evidence. It now runs the real built-in profile through SQLite-backed scheduling and the gateway to `Completed`, then asserts one persisted `ModelCallRecord` with the exact AgentRun UID, attempt 1, canonical policy digest, and terminal usage status. Interactive chats remain explicitly unbound because they are not AgentRuns; custom remote endpoint resolvers remain host-authoritative. Validation: core 1020/1020, CLI 413 passed with 8 explicit environment/integration skips, all other workspace suites, Node 24 production/declaration builds, portable boundaries, and lint with zero errors (four pre-existing unused-disable warnings) pass. This closes the real default-loop Run-binding gap; the separate general `ModelManagementDriver` adapter/evidence mapping tracked in §24.61 remains open.

**2026-07-27 provider-path compatibility correction:** Two OpenAI-backed NodeRuntime tests had remained permanently skipped, which hid production incompatibilities behind broad type assertions. MemeLoop used AI SDK 4 (`LanguageModelV1`) while most optional provider packages resolved to newer, incompatible model generations; the default `ModelProviderDriver` also passed the provider's model factory as a model ID and used request field names that `ILLMProvider` does not consume. The core and complete optional-provider matrix are now upgraded together to AI SDK 7 with Zod 4 (including `ollama-ai-provider-v2`), matching the current `memeloop-app` desktop generation. Every built-in provider family plus an arbitrary OpenAI-compatible endpoint is instantiated in a compatibility suite, and an obsolete or otherwise unsupported embedded-host model fails before transport. AI SDK 7's `instructions`/message contract is observed without duplicating system messages. The driver maps `modelId`, `max_tokens`, and `abortSignal` exactly. Streaming provider errors are propagated instead of being mistaken for a successful empty assistant message.

The mock OpenAI server now exposes the correct `/v1` base URL and standards-compliant SSE response, so the former skips are real runtime tests: one proves persisted dialogue output and the other proves a configured managed tool can complete an OpenAI tool-call round trip. Managed-tool descriptors now preserve Zod 3, Zod 4, and portable JSON Schema rather than silently widening Zod 3 inputs to an unconstrained object. `IToolRegistry.registerTool` accepts an optional schema; the core/generic CLI Node tools register their actual schemas, and legacy schema-less tools are omitted from the managed executor manifest instead of receiving fabricated unconstrained authority. Changed files: `packages/memeloop/package.json`, `packages/memeloop/src/llm-providers.ts`, `packages/memeloop/src/llm/fetchProvider.ts`, `packages/memeloop/src/llm/__tests__/providerCompatibility.test.ts`, `packages/memeloop/src/types.ts`, `packages/memeloop/src/orchestration/drivers/modelProviderDriver.ts`, its focused tests, the managed-tool schema/route files and tests, the CLI ToolRegistry/tool registration/runtime files, the OpenAI integration test/mock, and `pnpm-lock.yaml`. Validation: frozen offline install; provider compatibility 15/15; OpenAI runtime 4/4; complete workspace unit entry point (core 1065/1065, CLI 418 passed plus six real-etcd environment gates, worker 7/7, Kubernetes 30/30, Swarm 22/22, libp2p 23/23, protocol 6/6, React UI 33/33); the six gated etcd cases also pass 6/6 against a temporary real etcd 3.6.11 server; production/declaration builds and portable-boundary checks pass. The rebased TidGi Desktop host is upgraded to the same AI SDK 7 provider matrix; its frozen offline install, TypeScript check, focused Chat Completions integration (6/6), and complete 72-file unit suite (510 passed, three explicit skips) pass. Downstream changes are limited to `package.json` and `pnpm-lock.yaml`. No compatibility debt is knowingly deferred: downstream hosts that use MemeLoop's built-in provider factory must resolve this same provider generation, while hosts injecting an unsupported AI SDK generation receive the new explicit incompatibility error rather than corrupting a run.

### 24.66 Bootstrap remote SSH compute nodes

**Status:** completed
**Scope:** `memeloop-cli` and trusted Node/Desktop hosts.
**Completion criteria:** A trusted host can probe and install an exact CLI release on a new SSH machine without shell injection, implicit host-key trust, root access, mutable package coordinates, overwriting unrelated executables, or losing a rollback path.
**Implementation record:** 2026-07-28 — A release audit confirmed that the plan covered worker enrollment, libp2p bootstrap, and SSH-based fleet evidence but had omitted the product path that turns a newly supplied SSH server into a MemeLoop compute node. Added the public `bootstrapRemoteCli` Node adapter and `memeloop remote bootstrap <user@host>` command in CLI 0.1.1. The controller validates the SSH target, exact semantic version, port, paths, host-key policy, and timeout before spawning a fixed argv-only SSH command with `BatchMode=yes`; strict known-host verification is the default, while first-use `accept-new` is an explicit TOFU option that still rejects changed keys. The bounded source transported on stdin requires an already installed Node 24+ and npm, never invokes `sudo`, never downloads a shell script, and asks npm for only `memeloop-cli@<exact-version>`.

Remote installs are unprivileged and versioned at `~/.local/share/memeloop/cli/<version>`. A verified binary is selected atomically through `~/.local/bin/memeloop`; rerunning is idempotent, selecting an earlier installed version is rollback, incomplete version directories fail closed for operator inspection, and an unrelated existing link/file is preserved unless the caller explicitly supplies `--replace-existing-link`. `--dry-run` performs only SSH/Node/npm prerequisite checks. Output and execution time are bounded, npm/browser download noise is suppressed, Puppeteer's browser download is skipped for the compute-node package, and evidence contains only version, Node version, executable path, mutation flag, and dry-run flag. Three tests execute the real transported shell through a fake SSH boundary, cover strict argv construction and hostile inputs, and prove versioned install plus idempotent adoption with a fake registry installer. CLI build/declarations, built `--version`/help smoke, and packed-package validation pass. Node itself is deliberately not installed from an unauthenticated curl-to-shell source; downstream onboarding must provision Node 24 through its trusted image/configuration-management channel before invoking this bootstrap.

### 24.67 Keep provider and model recommendations current

**Status:** in progress
**Scope:** `memeloop/model-catalog`, `memeloop-cli`, and trusted Desktop hosts.
**Completion criteria:** A release build can refresh a bounded, attributable provider/model snapshot from a fixed source; normal runtime can refresh and cache the same schema with a bundled last-known-good fallback; configured providers can discover the models actually visible to the user's account without exposing credentials, following redirects, accepting unbounded responses, or deleting manual model entries; Desktop and CLI consume the dynamic catalog instead of stale hard-coded recommendations; focused tests, package gates, downstream builds, and CI pass.

**Implementation record (2026-07-30, pending release/CI closure):** The referenced `vscode-unify-chat-provider` implementation was audited rather than copied. Its recommended-provider metadata is still static; `official-models-manager.ts` supplies the separate account-discovery layer, with provider-specific list APIs, cache fallback, exact-ID metadata enrichment, invalidation, and bounded refresh behavior. MemeLoop therefore adopts an explicit two-layer design.

The first layer is the public `memeloop/model-catalog` subpath. It normalizes the fixed `https://models.dev/api.json` source into a versioned schema, validates source/schema/UTF-8/response size, rejects redirects, applies a bounded timeout, and exposes exact-ID capability enrichment. A release/build command refreshes the checked-in snapshot; normal offline builds remain reproducible. Runtime consumers cache a successfully validated refresh for 24 hours and fall back to the cache or embedded snapshot. The snapshot currently contains 175 providers and 5,892 models. `models.dev` is MIT licensed and is attributed in the repository and packed npm artifact.

The CLI derives its provider presets from this catalog, shows the embedded list immediately, refreshes asynchronously, atomically stores a private cache under the user's data directory, and reports cache/embedded fallback without making configuration unusable. Desktop likewise returns the embedded catalog immediately on a first run, refreshes in the main process, stores it below Electron `userData`, and sends only normalized non-secret recommendations to the renderer. Its old GPT-3.5/Claude-3-era provider list is removed; presentation-only feature labels remain local.

The second layer asks a configured OpenAI/OpenAI-compatible, Anthropic, Google, or loopback Ollama endpoint for the account-visible model IDs. Requests have a ten-second timeout, two-megabyte aggregate response limit, a twenty-page ceiling, redirect rejection, fatal UTF-8 decoding, HTTPS enforcement except loopback, and provider-specific authentication. Google credentials remain in a request header rather than a URL. Exact catalog metadata enriches discovered IDs. Previously discovered entries are replaceable, while every unmarked/manual model is retained. Desktop exposes this as an explicit “Refresh models” action and persists the result through the existing settings service; it never writes credentials into the catalog cache.

Evidence at the 0.1.2 release-candidate boundary: core catalog 6/6 and the complete core suite 1,098/1,098; CLI catalog/preset/bootstrap 9/9 and the complete CLI suite 433 passed with six explicit real-etcd gates; Desktop catalog/account discovery 11/11. Core and CLI production/declaration builds, lint, and the seven-package pack inspection pass; the packed `memeloop@0.1.2` artifact contains the catalog subpath and third-party notice. The first remote CI run found that the portable-boundary scanner interpreted a model ID inside the generated JSON string as executable `global.*` source. The scanner now excludes only this exact generated data module, whose executable wrapper is fixed to a type-only import, a string literal, and `JSON.parse`; the boundary gate passes locally without weakening scans of authored or other generated code. The latest Desktop settings virtualization refactor also exposed a test-mode regression: a mocked `ResizeObserver` caused the all-sections renderer to mount only virtual rows while its page-level tests waited for every section, and an unstable empty catalog default caused a render loop in isolated ProviderConfig tests. Test mode now deliberately uses the existing non-virtual fallback, while production remains virtualized; the empty default is referentially stable. Versioned npm publication, registry-based downstream dependency replacement, final downstream validation, pushed PRs, and CI remain before this step may be marked completed.

The second remote CI run proved all 1,098 core tests but exposed a test-harness budget error under the shared runner's workspace load: two real mock-HTTP NodeRuntime cases and one isolated-process/SQLite restart case completed in approximately seven seconds but were still governed by Vitest's five-second default. Comparable real runtime cases in the same run reached 6.9 seconds. Only those three integration cases now have a 30-second outer test budget; their internal 20/25-second behavioral deadlines remain unchanged, and the global unit-test timeout remains strict. The focused five-test suite passes locally. This correction changes no production behavior and does not reinterpret the CI failure as feature evidence; a fresh complete remote run remains required.

The fresh remote run `30519568814` is green across install, production/declaration build, complete unit suites, lint, portable-boundary enforcement, packed-manifest inspection, and the CLI production end-to-end job. The core branch is therefore release-ready at `memeloop@0.1.2` and `memeloop-cli@0.1.2`; npm publication remains an explicit human 2FA step and neither version was visible in the public registry at the time of this record.

Desktop was rebased again onto `master` at `e8c569a6`, retaining the current proxy-settings, IOC preferences, settings virtualization, and logging infrastructure. Its complete validation passes: TypeScript, the repository lint scope with zero warnings, and 88 unit-test files with 559 passing tests and three existing skips. A packaged-app acceptance found two external-runtime dependency defects that source tests could not expose: the ESM `electron-unhandled` package was absent, and copying only `@modelcontextprotocol/sdk` omitted its eagerly loaded `zod/v3`. The after-pack hook now resolves the real package root even when an export map points `package.json` into `dist`, copies both complete runtime dependency closures, treats them as critical packaging inputs, and catches failure of the optional global-error-handler initialization. The final Linux artifact contains `electron-unhandled`, `clean-stack`, `serialize-error`, the MCP SDK, and Zod. A 30-second fresh isolated launch initialized the agent and embedding databases, created and started the default wiki, reached `[test-id-ALL_WORKSPACE_VIEW_INITIALIZED]`, and contained no missing-package, unhandled-import, old-schema, or model-catalog error. The deliberate timeout then stopped the otherwise healthy long-running app. Registry replacement, Desktop/Mobile pushes and CI, and a fresh Windows artifact acceptance remain the release closure gates.

The Desktop catalog deliberately retains host-local protocols that are not represented by `models.dev`: Ollama remains a loopback provider with runtime discovery and ComfyUI remains a loopback Flux image provider. These presets are appended without overriding a catalog entry on collision. The resulting provider-selection acceptance passes all 55 assertions. Full packaged calibration then exposed a separate pre-existing race between consecutive workspace drag operations: a cancelled debounced update could leave React state stale even though the drag-state ref already matched, and the next drag inherited the previous target/intent. The reconciler now always applies the requested state, each drag starts from a clean state plus its active item, and the packaged E2E driver waits for the overlay to close and rendering to settle before beginning another drag. The focused scenario passes three consecutive runs (22/22 each), and the exact CI calibration command passes two complete rounds (13/13 scenarios and 401/401 assertions per round, approximately 3m35s each) with its calibration artifact stored successfully. These changes are committed in Desktop as `1b5b0c59` and `574f8a04`; they remain local until the registry dependency can be replaced without committing the temporary workspace link.

Both public packages were then published with human two-factor approval as `memeloop@0.1.2` and `memeloop-cli@0.1.2`; registry inspection confirms the catalog export and Node 24 CLI contract. The first registry-based Desktop matrix exposed a prompt-isolation defect outside the catalog itself: disabling the injected Wiki/planning tools removed their schemas but the general-assistant base prompt still named concrete legacy tool identifiers, so the packaged prompt truthfully failed the exclusion assertion. The base contract now refers only to enabled tools and their injected names/schemas, retains exact Wiki filter guidance without assuming a concrete tool identifier, and advances the built-in profile to 1.1.1. A regression test rejects the disabled identifiers in both prompt representations. Because npm versions are immutable, this correction is staged as `memeloop@0.1.3` and the exact remote bootstrap coordinate is staged as `memeloop-cli@0.1.3`. Local evidence: core 1,098/1,098, CLI 433 passed with six explicit real-etcd gates, both lints, portable boundaries, production/declaration builds, and packed 0.1.3 manifests pass; the core tarball contains the model-catalog import/require/type surfaces and third-party notice. Publication, fresh registry-based downstream CI, and Windows artifact acceptance remain open.

Remote core CI `30535593834` independently passed the complete 0.1.3 gate. The same failed Desktop matrix also exposed two host defects rather than flaky assertions: the Agent switcher used a styled `div` with simulated disabled state, allowing Playwright and users to activate it during the streaming tail even though the handler silently ignored the event; and the non-virtual settings path delegated nested scrolling to `scrollIntoView`, which could overshoot after asynchronous section layout. Desktop commit `97bf8c3c` uses a real disabled button, gives both virtual and fallback settings lists an explicit owned viewport, and repeatedly settles fallback navigation against measured geometry before completing it. The three exact packaged scenarios now pass locally: disabled-tool prompt isolation 27/27, Agent switching 27/27, and External API/notification deep-link alignment 16/16. TypeScript, zero-warning lint, and the complete Desktop unit suite pass with 561 tests and three existing skips. The source commit deliberately excludes the temporary local MemeLoop link and the user's `template/wiki` state; it will be pushed only with the registry-based 0.1.3 dependency update.

`memeloop@0.1.3` is now public and registry inspection confirms the `model-catalog` import, require, and type exports with integrity `sha512-l8bxJECB09orvqt1o46L3W2KSes4/4BT50C0yjiAB1mjO6/UrLaRhYPlWIxMVLOHNxjdSeklaxDCNaI1J23ncw==`. Desktop commit `4d498c3b` and Mobile commit `a4f8d18` replace the temporary workspace package with that immutable registry release and were pushed to PRs 743 and 109 respectively. Desktop Release App run `30537570669` passed its unit/lint job, Linux and Windows calibration, all six packaged E2E shards, and all six Linux/macOS/Windows x64/arm64 build jobs; CodeQL run `30537570576` also passed. Mobile runs `30536943185`, `30536943254`, `30536943202`, and `30536943454` passed the Dev Client/Detox, release APK, AAB, and NPM APK builds. Local registry-based validation independently passed Desktop TypeScript, zero-warning lint, 561 tests with three existing skips, packaging, and the three corrected packaged scenarios; Mobile TypeScript, 19 tests, and lint with only its two pre-existing color-literal warnings passed.

The exact Windows x64 Squirrel artifact from run `30537570669` was then accepted on `DONGWU-GAMING-W` without stopping or modifying the already installed TidGi instance. Because Squirrel's application-wide single-instance lock was already held by that instance, the extracted CI executable ran through a bounded one-time SYSTEM scheduled task while its working directory, scenario, user data, caches, settings, logs, and Wiki were all confined below `I:\Temp\TidGi-MemeLoop-Acceptance-20260730-1150`. After more than 45 seconds the artifact retained seven live processes, created 247 fresh files (16,590,034 bytes), including an 86,016-byte `agent-cache.db`, a 192,512-byte `wikiEmbedding-cache.db`, settings, and the complete default Wiki, and reached both `[test-id-ALL_WORKSPACE_VIEW_INITIALIZED]` and `DeviceNetworkService started`. Log scans found zero `ERR_MODULE_NOT_FOUND`, missing module/package, `electron-unhandled`, `zod/v3`, SQLite schema/table, model-catalog, or unhandled-rejection failures. Only the seven path-scoped acceptance processes and the temporary scheduled task were removed; the three pre-existing installed TidGi processes remained running, and the isolated evidence directory was retained.

The immutable SSH bootstrap coordinate is now closed: the user completed the human two-factor publication of `memeloop-cli@0.1.3`, and public-registry inspection returns integrity `sha512-I0tuGBTmWkom+rr0N1X2GZWL6ci9CIxi9cvmB1zyBjq2jbm81VxzIka0IITN8xR+Y2Vld28doUC98Viv6akQaw==`. Both 0.1.3 package coordinates used by the downstream branches are therefore immutable and publicly installable.

A subsequent launch of the normal installed Windows application supplied the missing historical-data evidence: TypeORM attempted to add the new non-null message identity columns while recreating `agent_instance_messages`, and an old row with no `messageId` caused an unhandled `NOT NULL constraint failed` rejection during application bootstrap. The product decision is intentionally stricter and simpler than an accumulating legacy migration chain: current MemeLoop Agent services exclusively use the new database key `meme-loop` (`meme-loop-cache.db`) and never open the legacy `agent-cache.db`. Agent initialization is also a non-critical bootstrap boundary; a failure is logged and disables Agent services for that session without preventing Wiki, Preferences, or the rest of TidGi from starting. The existing Preferences recovery action reports the current MemeLoop database and deletes both the current and legacy database plus their WAL/SHM sidecars before the already established restart flow. Desktop commits `ec62efcb` and `1958c371` implement this policy with focused bootstrap, sidecar-deletion, and Settings tests. The complete local Desktop gate passes TypeScript, zero-warning lint, and 92 unit-test files with 567 passing tests and three existing skips.

Real host acceptance then exercised the product rather than only mocks. A fresh development instance initialized `meme-loop-cache.db`, exposed the recovery UI, and served its built-in MCP endpoint. SiliconFlow account discovery returned all seven requested model IDs, and isolated application-runtime conversations succeeded for `Qwen/Qwen3.5-9B`, `Qwen/Qwen3.5-27B`, `deepseek-ai/DeepSeek-V3.2`, `deepseek-ai/DeepSeek-V4-Flash`, `deepseek-ai/DeepSeek-V4-Pro`, `Pro/moonshotai/Kimi-K2.6`, and `zai-org/GLM-5.2` in approximately 4–24 seconds. A Wiki-backed memory test exposed a host bug: filter search found an exact title but passed that raw title to `getTiddlersAsJson`, which expects a filter and silently returned no body. Desktop commit `44cde26d` now reads each exact result through `getTiddlerText` and includes empty-string bodies correctly. After the fix, the agent searched the Wiki, read and returned the exact sentinel, and created a two-item persistent todo through `manage-todo`; the todo tiddler was independently read back with one completed and one pending item. Test artifacts were removed. The exact Windows legacy-database install/start/clear acceptance and the new Desktop CI run remain the final downstream closure gates; they are not claimed complete here.

Desktop was then rebased onto `master` at `0dddd9cd` and advanced to `0.14.2-prerelease4`. Commits `04d28b9a` and `806259ae` removed the cold Agent import gap and kept the Wiki attachment picker open. Production Squirrel handling was found to import the complete application before recognizing install/update/uninstall events, causing the hook timeout seen in both previous installers; `a137bb8f` replaces that path with a small static entry and dynamically imports the application only for a normal launch. The built main entry is approximately 62 KB and the full application is a separate dynamic chunk. Local validation passed 94 unit files, TypeScript, and zero-warning lint.

The next complete CI run exposed two independent product races rather than a reason to rerun unchanged tests. `AgentChatView` supplied a newly allocated component type to assistant-ui on every message update, unmounting the composer and losing a draft typed during delete/retry transitions. Core commit `55b2959` keeps that component identity stable, adds a DOM regression test, advances `@memeloop/react-ui` to 0.1.1, and passes all 34 React UI tests, lint, declarations, and build; core CI run `30569194199` is green. Desktop's async `Workspace.update` could likewise merge two partial changes against the same stale snapshot, allowing a navigation update to overwrite `enableFileSystemWatch` after Settings enabled it. Desktop commit `68eaab5f` serializes same-workspace mutations and proves both fields survive a deliberately delayed concurrent persistence. Its local gate passes 94 files and 573 tests with three existing skips, TypeScript, and zero-warning lint. A temporary pnpm patch carries the exact unpublished React UI correction so CI evidence does not depend on a human 2FA window.

Desktop Release App run `30569847613` is green for unit/lint, Linux and Windows calibration, all six packaged E2E shards, and all six Linux/macOS/Windows x64/arm64 builds; in particular, the previously failing Ubuntu shard now passes the composer-draft scenario and both file-watcher GitLog scenarios. CodeQL run `30569847544` is also green. PR 743 is clean at `68eaab5f`; Mobile PR 109 remains green across its Dev Client/Detox, APK, AAB, and NPM APK builds.

The exact Windows x64 installer from that run has SHA-256 `ff451300691e54b5c01693a66d69eb9f1ff29627ce63ea4e699f84cbcb56f03f`. On `DONGWU-GAMING-W`, both databases were copied and hashed before replacing the earlier same-version build. The installed `app.asar` changed from `71aa9e272aeb96110b60abb750743cbd3c53b159dfda2711c999b0ffde27e054` to `0a4f1fadda8558779c7a8030b4b9e0eca69a7fbebef7dd00f79efd2679c52f5`; the silent installer exited 0 and did not leave a hook process. A real interactive production launch retained 11 processes for more than four minutes and emitted 221,852 bytes of new logs containing Agent repository/tool initialization, `ALL_WORKSPACE_VIEW_INITIALIZED`, and `DeviceNetworkService started`, with none of the bounded SQLite, unhandled-promise, missing-package, or Agent-bootstrap failure patterns.

The installed Settings UI was then driven through Chromium DevTools: “删除人工智能对话数据库” opened the localized irreversible-action confirmation, “删除” closed it and displayed the restart notice, and an independent 100 ms filesystem observer saw both `meme-loop-cache.db` and legacy `agent-cache.db` transition from present to absent. The application was stopped and the backups were restored exactly: legacy SHA-256 `7f57d05a9d2356af84687d725ee13311aa0f18a57a9eacf9dff3cddd8d0ecd8a`, current SHA-256 `383e5ff7955601e84207cad8a6ab8e5e0b16e2f6c7b8cdd52adec6d2073504e1`. A final ordinary launch again retained 11 processes with one main process and no debugging flags; removing the run-scoped scheduled task did not stop the application. Run evidence and database backups remain below `I:\Temp\TidGi-MemeLoop-Acceptance-20260731-68eaab5f`.

The remaining closure item is narrow and release-only: publish the inspected `@memeloop/react-ui@0.1.1` tarball (SHA-256 `f8e11ba15fcc47f666b6d6da76cf1562425c1399983666bd688fdb6166c79187`) with human npm authentication, replace the temporary Desktop patch with that immutable registry version, and pass the resulting final Desktop CI. The Codex npm credential expired with `npm whoami` returning 401, so this step remains in progress rather than being reported complete.
