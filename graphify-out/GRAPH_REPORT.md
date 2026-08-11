# Graph Report - .  (2026-08-10)

## Corpus Check
- 157 files · ~143,145 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2198 nodes · 4061 edges · 160 communities (133 shown, 27 thin omitted)
- Extraction: 93% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 261 edges (avg confidence: 0.84)
- Token cost: 556,527 input · 62,000 output

## Community Hubs (Navigation)
- Filesystem Store Adapter
- HTTP Proxy Framing
- Mailbox Engine & Key Layout
- Root Package Manifest
- Injected Clock & Timers
- E2E Scenario Harness
- Runtime Config Parsing
- Workspace Crypto & KeyRing
- Transport Definitions & Config
- Chunking & Envelope
- GitHub gh CLI Client
- Transport Policy & Health Config
- Peer Keys & Workspace Status
- TypeScript Base Config
- Peer Identity & Wrapped Keys
- Logger & Redaction
- Metrics Primitives
- Transport SDK Manifest
- Dashboard HTTP Server
- Conformance Test Harness
- Delivery Guarantees
- Control Plane & Logger API
- CLI Entry Point
- Release Verification Gates
- SDK Client
- Error Payloads & JSON Codec
- X25519 Identity Crypto
- Vendored Frontend Library
- Exposures & Presence Config
- Transport Manager & Retry
- CI Workflow Gates
- CLI Command Dispatch
- Security Boundaries & Scenarios
- Tracing & Breaker Options
- Dashboard Frontend App
- PR Template & Public Surface
- Release Checklist & Publishing
- Inbox Reaping Rationale
- Layering Invariants
- Architecture Overview
- Two-Peer Scenario
- Live GitHub Scenario
- Data Branch Compaction
- TTL & Retention Semantics
- Per-Peer Key Wrapping
- Transport Config Fields
- Retry & Policy Config Fields
- Message Ids & Test Stores
- Secrets & Init Commands
- Failover Scenario
- Conformance Contract Rules
- Project Positioning
- Reaper Design Rationale
- Runtime Package Manifest
- CLI Formatting & Trace Output
- Git Workdir Lock
- Demo & Examples Setup
- Encryption & Object Key Layout
- Proxy Mode & Correlation
- Git Transport Config
- Build Commands & Verify Gate
- Reference Transport ADR
- Control Plane Socket ADR
- Dedupe Store
- Circuit Breaker
- Release E2E Verification
- Transport Resilience History
- Secret Handling & Roadmap
- custom-transport Example Manifest
- express-proxy Example Manifest
- sdk-rpc Example Manifest
- Id Generation
- Git Transport Tests
- Versioning & Release Rules
- Error Model & Clock Rules
- Two-Peer Demo
- Mailbox Delivery Mechanisms
- Socket Discovery & Dashboard Docs
- Dashboard Scenario
- Test Fixtures & Faulty Transport
- Filesystem Conformance Tests
- Runtime tsconfig
- Two-Package Layout
- Discovery & Proxy History
- Hostile Storage & Leaks
- Git Transport Scenario
- Key Validation Helpers
- Package Subpath Exports
- Tracer Spans
- GitHub Store Adapter
- Transport SDK tsconfig
- Git Push Verification Traps
- Dashboard Runtime Hazards
- Test Strategy Details
- Config & Socket Path Resolution
- Transport Definition API
- Faulty Store Fixture
- Examples CI Integration
- Two Transport Kinds ADR
- Enrollment Token Model
- Transport Kinds & Polling
- Identity vs From Authorization
- Shared Secret Threat Model
- Frame Encryption Details
- Transport Authoring Checklist
- Package Keywords
- Runtime README Surface
- Listing Store Fixture
- E2E Suite Policy
- TTL From Key Design
- Runtime Config API
- Metrics Registry
- Transport Import Guard Test
- Demo Secret Handling
- At-Least-Once Delivery
- Live Tier Testing
- Problem Statement & Non-Goals
- Configuration Scenario
- Broadcast Scenario
- Key Rotation Scenario
- Reaping Scenario
- Prettier Config
- Naming & Release Rules
- Rejected Control Plane Options
- Published Files List
- CLI IO Interface
- Transport Logger Interface
- Dependency Discipline
- Socket Path Limits
- Store vs Native Kinds
- Exposures Scenario
- Repository Metadata
- Minor Cluster 132
- Minor Cluster 133
- Minor Cluster 134
- Minor Cluster 135
- Minor Cluster 136
- Minor Cluster 137
- Minor Cluster 138
- Minor Cluster 139
- Minor Cluster 140
- Minor Cluster 141
- Minor Cluster 142
- Minor Cluster 143
- Minor Cluster 144
- Minor Cluster 145
- Minor Cluster 146
- Minor Cluster 147
- Minor Cluster 148
- Minor Cluster 149
- Minor Cluster 150
- Minor Cluster 151
- Minor Cluster 152
- Minor Cluster 154
- Minor Cluster 155
- Minor Cluster 156
- Minor Cluster 158
- Minor Cluster 159

## God Nodes (most connected - your core abstractions)
1. `DeadDropError` - 53 edges
2. `Workspace` - 52 edges
3. `MailboxEngine` - 37 edges
4. `Clock` - 32 edges
5. `TransportManager` - 31 edges
6. `GitStore` - 29 edges
7. `Logger` - 26 edges
8. `Envelope` - 23 edges
9. `DeadDropRuntime` - 23 edges
10. `compilerOptions` - 23 edges

## Surprising Connections (you probably didn't know these)
- `Errors say what to do next` --semantically_similar_to--> `discover distinguishes unreachable from empty (0.6.0)`  [INFERRED] [semantically similar]
  CONTRIBUTING.md → CHANGELOG.md
- `Talking through already-shared infrastructure` --semantically_similar_to--> `dead-drop transport-agnostic runtime`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `AGENTS.md as the single source of repository instructions` --references--> `Invariant 10: DeadDropError identity is a registry symbol, never instanceof`  [AMBIGUOUS]
  CLAUDE.md → AGENTS.md
- `A test that would have caught the bug beats a test that covers the fix` --semantically_similar_to--> `Tests prove behaviour, not coverage`  [INFERRED] [semantically similar]
  AGENTS.md → CONTRIBUTING.md
- `Errors say what to do next` --semantically_similar_to--> `Non-retryable health failures logged at error level (0.2.3)`  [INFERRED] [semantically similar]
  CONTRIBUTING.md → CHANGELOG.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Layer stack enforced by no-restricted-imports (protocol <- core <- runtime <- sdk/cli)** — agents_layer_protocol, agents_layer_core, agents_layer_runtime, agents_layer_sdk, agents_layer_cli, agents_layering_enforcement, agents_transports_directory [EXTRACTED 1.00]
- **The ten invariants that are bugs to break even when tests pass** — agents_invariant_no_transport_naming, agents_invariant_two_transport_kinds, agents_invariant_control_plane_socket, agents_invariant_delivery_guarantee, agents_invariant_message_id_is_trace_id, agents_invariant_transport_imports, agents_invariant_sdk_only_public_contract, agents_invariant_no_bridge_name, agents_invariant_hostile_storage, agents_invariant_error_symbol_brand [EXTRACTED 1.00]
- **Transport resilience flow: health scoring, retry, breaker, failover and honest retryable errors** — agents_deaddroperror, changelog_health_scoring_failover, changelog_retry_breaker_config, changelog_fast_failover_past_open_breaker, changelog_request_timeout_bounds_whole_request, readme_transport_policy_failover, changelog_non_retryable_health_logging [INFERRED 0.85]
- **Delivery semantics implemented once over store primitives** — docs_adr_0001_store_and_native_transports_store_kind, docs_adr_0001_store_and_native_transports_mailbox_engine, docs_adr_0001_store_and_native_transports_delete_as_acknowledgement, docs_adr_0001_store_and_native_transports_redelivery_with_backoff, docs_adr_0001_store_and_native_transports_deduplication, docs_adr_0001_store_and_native_transports_chunking_and_reassembly, docs_adr_0001_store_and_native_transports_adaptive_polling, docs_adr_0001_store_and_native_transports_dead_letters, docs_adr_0001_store_and_native_transports_broadcast_topics_resume_cursor [EXTRACTED 1.00]
- **Credential-free test ladder: filesystem, local bare repo, fake gh, manual checklist** — docs_adr_0002_filesystem_as_reference_transport_filesystem_reference, docs_adr_0002_filesystem_as_reference_transport_local_bare_repository, docs_adr_0002_filesystem_as_reference_transport_scripted_fake_gh, docs_adr_0002_filesystem_as_reference_transport_manual_checklist, docs_adr_0002_filesystem_as_reference_transport_end_to_end_suite [EXTRACTED 1.00]
- **Runtime entanglement hazards that force the dashboard to hold no runtime** — docs_adr_0004_dashboard_binds_tcp_and_holds_no_runtime_no_runtime_construction, docs_adr_0004_dashboard_binds_tcp_and_holds_no_runtime_workdir_ownership, docs_adr_0004_dashboard_binds_tcp_and_holds_no_runtime_phantom_peers, docs_adr_0004_dashboard_binds_tcp_and_holds_no_runtime_unbounded_commits, docs_adr_0004_dashboard_binds_tcp_and_holds_no_runtime_ddrop_connect [EXTRACTED 1.00]
- **Compaction survives races because existing code paths already handle it** — docs_adr_0005_compacting_the_data_branch_compaction, docs_adr_0005_compacting_the_data_branch_force_with_lease, docs_adr_0005_compacting_the_data_branch_flush_lock, docs_adr_0005_compacting_the_data_branch_applybatch, docs_adr_0005_compacting_the_data_branch_isnonfastforward, docs_adr_0005_compacting_the_data_branch_sync [EXTRACTED 1.00]
- **The age-plus-absence reaping decision** — docs_adr_0006_reaping_orphaned_inboxes_reap, docs_adr_0006_reaping_orphaned_inboxes_inboxorphanms, docs_adr_0006_reaping_orphaned_inboxes_age_from_key, docs_adr_0006_reaping_orphaned_inboxes_beacon_absence, docs_adr_0006_reaping_orphaned_inboxes_partial_view_rule [EXTRACTED 1.00]
- **Per-era key distribution: enroll, wrap, unwrap, seal** — docs_adr_0007_per_peer_key_wrapping_enrollment_token, docs_adr_0007_per_peer_key_wrapping_peer_identity, docs_adr_0007_per_peer_key_wrapping_enrollment_proof, docs_adr_0007_per_peer_key_wrapping_era_key, docs_adr_0007_per_peer_key_wrapping_wrapped_era_key, docs_adr_0007_per_peer_key_wrapping_keyring [EXTRACTED 1.00]
- **Transport selection, health and failover** — docs_configuration_policy, docs_configuration_breaker, docs_configuration_retry, docs_configuration_healthintervalms, docs_configuration_mode_score, docs_guarantees_failover, docs_operations_metric_failovers_total [INFERRED 0.85]
- **Keeping the transport store bounded** — docs_configuration_inboxorphanms, docs_configuration_orphan_reaping, docs_configuration_branch_compaction, docs_configuration_presence_beacon, docs_operations_topicretentionms, docs_guarantees_expiry [INFERRED 0.85]
- **Delivery semantics: at-least-once with dedupe and dead letters** — docs_guarantees_at_least_once, docs_guarantees_delete_is_ack, docs_guarantees_deduplication, docs_guarantees_redelivery_backoff, docs_guarantees_dead_letters, docs_guarantees_ordering [EXTRACTED 1.00]
- **Shared-secret identity and its four accepted consequences** — docs_security_model_shared_secret_identity, docs_security_model_peer_impersonation, docs_security_model_member_reads_all_mail, docs_security_model_member_deletes_all_mail, docs_security_model_revocation_by_rotation, docs_security_model_adr_0007 [EXTRACTED 1.00]
- **Frame confidentiality chain: secret to derived key to sealed frame** — docs_security_model_workspace_secret, docs_security_model_hkdf, docs_security_model_aes_256_gcm, docs_security_model_key_id, docs_security_model_authenticated_preamble, docs_security_model_key_rotation [EXTRACTED 1.00]
- **The third-party transport contract, end to end** — docs_writing_a_transport_package_model, docs_writing_a_transport_define_transport, docs_writing_a_transport_capabilities, docs_writing_a_transport_store_contract, docs_writing_a_transport_conformance_suite, docs_writing_a_transport_publish_checklist, docs_vision_plugin_ecosystem [EXTRACTED 1.00]
- **The release gate: checklist, CI jobs, and the publish workflow** — _github_release_checklist_release_checklist, _github_workflows_ci_verify, _github_workflows_ci_scenarios, _github_workflows_ci_windows, _github_workflows_release_publish, _github_release_checklist_verify_release_script [INFERRED 0.85]
- **Four-method store transport plus conformance proof** — packages_transport_sdk_readme_definetransport, packages_transport_sdk_readme_store_kind, packages_transport_sdk_readme_transportconformancecases, packages_dead_drop_readme_runtime_supplied_reliability, examples_readme_custom_transport [EXTRACTED 1.00]
- **Read-only dashboard mirroring status, discover, queues and logs** — packages_dead_drop_static_index_overview_section, packages_dead_drop_static_index_queues_section, packages_dead_drop_static_index_peers_section, packages_dead_drop_static_index_transports_section, packages_dead_drop_static_index_logs_section, packages_dead_drop_static_index_read_only [EXTRACTED 1.00]

## Communities (160 total, 27 thin omitted)

### Community 0 - "Filesystem Store Adapter"
Cohesion: 0.06
Nodes (14): FilesystemStore, execFileAsync, firstLine(), Git, GitOptions, GitResult, isNonFastForward(), isRetryableGitError() (+6 more)

### Community 1 - "HTTP Proxy Framing"
Cohesion: 0.05
Nodes (45): app, client, secret, server, chunks(), decodeHttpRequest(), decodeHttpResponse(), decodePart() (+37 more)

### Community 2 - "Mailbox Engine & Key Layout"
Cohesion: 0.09
Nodes (15): deadLetterKey(), deadLetterPrefix(), inboxKey(), inboxPrefix(), messageIdFromKey(), topicKey(), topicPrefix(), ADR-0007 (+7 more)

### Community 3 - "Root Package Manifest"
Cohesion: 0.04
Nodes (45): eslint, @eslint/js, bugs, description, devDependencies, eslint, @eslint/js, prettier (+37 more)

### Community 4 - "Injected Clock & Timers"
Cohesion: 0.10
Nodes (20): abortError(), drainMicrotasks(), ScheduledTask, systemClock, TestClock, DeliveryState, MessageHandler, BreakerState (+12 more)

### Community 5 - "E2E Scenario Harness"
Cohesion: 0.07
Nodes (28): can(), cannot(), cleanup(), context(), dd(), dd_json(), dump_context(), fail() (+20 more)

### Community 6 - "Runtime Config Parsing"
Cohesion: 0.12
Nodes (33): isLogLevel(), JitterMode, isValidName(), assertNoPlaceholder(), DEFAULT_DATA_DIR, expandDeep(), expandEnv(), expandRefs() (+25 more)

### Community 7 - "Workspace Crypto & KeyRing"
Cohesion: 0.09
Nodes (23): deriveWorkspaceKey(), KeyRing, open(), parseWorkspaceSecret(), safeEqual(), seal(), SealResult, ADR-0007 (+15 more)

### Community 8 - "Transport Definitions & Config"
Cohesion: 0.10
Nodes (26): ADR-0005, filesystemTransport, FilesystemTransportConfig, maxKey(), relativeOrDot(), safeDirName(), memoryTransport, MemoryTransportConfig (+18 more)

### Community 9 - "Chunking & Envelope"
Cohesion: 0.11
Nodes (21): ChunkAssembler, ChunkAssemblerOptions, chunkEnvelope(), PendingGroup, assertValidChunk(), assertValidHeader(), ChunkInfo, createEnvelope() (+13 more)

### Community 10 - "GitHub gh CLI Client"
Cohesion: 0.11
Nodes (20): GitTransportConfig, execFileAsync, firstLine(), GhCli, GhClient, GhCliOptions, GhRateLimit, GhRepoInfo (+12 more)

### Community 11 - "Transport Policy & Health Config"
Cohesion: 0.07
Nodes (33): breaker block (circuit breaker), breaker.failureThreshold, breaker.resetTimeoutMs, breaker.successThreshold, ddrop transport list, deaddrop_messages_dropped_total{reason=duplicate}, filesystem.forcePolling, github.rateLimitIntervalMs (+25 more)

### Community 12 - "Peer Keys & Workspace Status"
Cohesion: 0.09
Nodes (11): inboxRoot(), parseInboxKey(), parsePeerKey(), peerKey(), peersPrefix(), MailboxStats, TransportInfo, ConnectOptions (+3 more)

### Community 13 - "TypeScript Base Config"
Cohesion: 0.06
Nodes (30): ES2023, node, ./packages/dead-drop/src/*, ./packages/transport-sdk/src/*, compilerOptions, composite, declaration, declarationMap (+22 more)

### Community 14 - "Peer Identity & Wrapped Keys"
Cohesion: 0.10
Nodes (23): identityKey(), identityPrefix(), parseIdentityKey(), parseWrappedKey(), wrappedKeyKey(), wrappedKeyPrefix(), wrappedKeyRoot(), enrollmentProof() (+15 more)

### Community 15 - "Logger & Redaction"
Cohesion: 0.12
Nodes (15): defaultWrite(), isSecretKey(), jsonSink(), LEVEL_ORDER, LOG_LEVELS, LogSink, MemoryLogSink, prettySink() (+7 more)

### Community 16 - "Metrics Primitives"
Cohesion: 0.10
Nodes (15): Counter, CounterSnapshot, DEFAULT_LATENCY_BUCKETS, DEFAULT_SIZE_BUCKETS, escapeLabel(), formatLabels(), Gauge, GaugeSnapshot (+7 more)

### Community 17 - "Transport SDK Manifest"
Cohesion: 0.08
Nodes (26): bugs, default, description, engines, node, exports, ./testing, files (+18 more)

### Community 18 - "Dashboard HTTP Server"
Cohesion: 0.10
Nodes (20): openBrowser(), API_ROUTES, ASSET_DIR, ASSETS, browserOpenCommand(), DashboardHandle, DashboardOptions, FORWARDED_PARAMS (+12 more)

### Community 19 - "Conformance Test Harness"
Cohesion: 0.15
Nodes (15): frame(), assert(), assertBytesEqual(), AssertionFailed, collect(), ConformanceCase, ConformanceHarness, nativeCases() (+7 more)

### Community 20 - "Delivery Guarantees"
Cohesion: 0.09
Nodes (25): concurrency, Concurrency trades ordering, dataDir, Policy affects writes only, Broadcast subscribers get no retry (cursor moved on), Cases deduplication does not catch, Deduplication store (10 000 keys / 1 hour, persisted), Delivery guarantees (+17 more)

### Community 21 - "Control Plane & Logger API"
Cohesion: 0.12
Nodes (11): runtimeFor(), secret, Logger, LogLevel, LogRecord, RuntimeConfig, ControlPlaneHandle, ControlPlaneOptions (+3 more)

### Community 22 - "CLI Entry Point"
Cohesion: 0.10
Nodes (12): version, resolveInitSecret(), run(), generateWorkspaceSecret(), dirs, fakeControlPlane(), servers, temp() (+4 more)

### Community 23 - "Release Verification Gates"
Cohesion: 0.10
Nodes (23): A gate that encodes a fact expires when the fact does; assert the rule, A green CI run does not prove the tarball is right, No source file hard-codes a version (version.test.ts), 104-byte control socket path limit check, verify-release.sh registry verification, Windows uses named pipes rather than Unix sockets, Control socket discovered through dataDir, createClient (native SDK) (+15 more)

### Community 24 - "SDK Client"
Cohesion: 0.15
Nodes (8): ControlPlaneClient, ClientOptions, DeadDropClient, PeerRecord, QueueDepth, QueueReport, RuntimeStatus, TransportInfoLike

### Community 25 - "Error Payloads & JSON Codec"
Cohesion: 0.14
Nodes (14): decodeJson(), encodeJson(), ErrorPayload, isErrorPayload(), unwrapRemoteError(), readJson(), BRAND, DEAD_DROP_ERROR_CODES (+6 more)

### Community 26 - "X25519 Identity Crypto"
Cohesion: 0.21
Nodes (18): deriveWrappingKey(), eraKeyFrom(), exportPrivateKey(), exportPublicKey(), fingerprint(), generateEraKey(), generateIdentity(), importPrivateKey() (+10 more)

### Community 27 - "Vendored Frontend Library"
Cohesion: 0.20
Nodes (22): a, b(), c(), d(), e(), f(), g(), h() (+14 more)

### Community 28 - "Exposures & Presence Config"
Cohesion: 0.10
Nodes (22): ddrop connect <peer>/<name>, exposure.directory, exposure.name, exposure.target, exposure.timeoutMs, exposure.type (http | static), workspace.exposures, git.workDir (+14 more)

### Community 29 - "Transport Manager & Retry"
Cohesion: 0.17
Nodes (5): SendOptions, healthToNumber(), traceContext, RetryPolicy, TransportManager

### Community 30 - "CI Workflow Gates"
Cohesion: 0.11
Nodes (21): npm run verify passes (lint, build, coverage thresholds), main green on all three CI jobs including Windows, npm run verify from a clean npm ci checkout, npm run format:check gate, npm run build gate, CI workflow, Concurrency group cancels superseded runs, Configure git for the transport tests (+13 more)

### Community 31 - "CLI Command Dispatch"
Cohesion: 0.28
Nodes (18): buildQuery(), call(), client(), connectCommand(), discover(), dispatch(), expose(), formatDuration() (+10 more)

### Community 32 - "Security Boundaries & Scenarios"
Cohesion: 0.12
Nodes (20): allowPeers is organisational, not a boundary, Control plane on a 0600 Unix socket, Denial-of-service bounds, Exposures and workspace-wide reach, Static exposure traversal rejection, Proxy hop-by-hop stripping and no redirect following, Credentials stay in the runtime, Undecodable objects are deleted (+12 more)

### Community 33 - "Tracing & Breaker Options"
Cohesion: 0.14
Nodes (10): Clock, LoggerOptions, Tracer, CircuitBreakerOptions, DedupeStoreOptions, RetryOptions, withRetry(), TransportManagerOptions (+2 more)

### Community 34 - "Dashboard Frontend App"
Cohesion: 0.17
Nodes (16): applyPeers(), applyQueues(), applyWorkspace(), asProblem(), bytes(), connectionEl, duration(), optionValues() (+8 more)

### Community 35 - "PR Template & Public Surface"
Cohesion: 0.12
Nodes (19): ADR required when deviating from docs/design-sketch.md, Angular commit convention: type(scope): subject, New behaviour needs a test that fails without the change, Pull request template, Public surface: wire format, transport contract, config schema, CLI flags, exported types, Invariant 10: transport-sdk dependency must be a caret range, DeadDropError identity breaks with a second SDK copy, turning permanent failure into infinite retry, The two packages do not share a version (+11 more)

### Community 36 - "Release Checklist & Publishing"
Cohesion: 0.11
Nodes (19): Invariant 8: the word 'bridge' must not appear, CHANGELOG.md entry with breaking changes called out, Every checklist item exists because something went wrong once, NPM_TOKEN read-write for the @fyrlabs scope, Release checklist, Publishing the GitHub release is what publishes to npm, Tag and release title are both vX.Y.Z, no dead-drop prefix, Breaking changes section, written N/A rather than deleted (+11 more)

### Community 37 - "Inbox Reaping Rationale"
Cohesion: 0.13
Nodes (19): ADR 0006: reaping orphaned inboxes, inboxOrphanMs setting, Reaping another peer's mail, Threat: any member deletes every message, Cleartext object key layout, Presence beacon, Readable keys are on purpose, Coverage thresholds as a floor (+11 more)

### Community 38 - "Layering Invariants"
Cohesion: 0.14
Nodes (18): Invariant 3: control plane is a Unix socket mode 0600 or a Windows named pipe, never TCP, cli layer (ddrop command), core layer, protocol layer, runtime layer, sdk layer, Layering enforced by no-restricted-imports, Tests mirror src, never live in src (+10 more)

### Community 39 - "Architecture Overview"
Cohesion: 0.15
Nodes (18): compactAfterCommits config field, Compaction degrades gracefully, pushRetries budget, Refused compaction waits a full threshold, A failed or refused delete is not retried every cycle, dead-drop architecture overview, Circuit breaker, @fyrlabs/dead-drop/core (+10 more)

### Community 40 - "Two-Peer Scenario"
Cohesion: 0.12
Nodes (3): discovers(), never_discovers(), 03-two-peers.sh script

### Community 41 - "Live GitHub Scenario"
Cohesion: 0.13
Nodes (4): has_compacted(), history_is_unreachable(), observed(), 01-github.sh script

### Community 42 - "Data Branch Compaction"
Cohesion: 0.16
Nodes (17): ADR 0005: compacting the data branch by re-orphaning under a lease, applyBatch replay loop, git commit-tree (parentless commit), Compaction (re-orphaning the data branch), The data branch, Rejected: delete and recreate the branch, ensureClone memoised-failure clearing, Rejected: epoch scheme (a branch per generation) (+9 more)

### Community 43 - "TTL & Retention Semantics"
Cohesion: 0.13
Nodes (17): ADR 0006: reaping orphaned inboxes, Stale beacon reaping, inboxOrphanMs, Orphaned inbox reaping, Per-message TTL in the encrypted header, workspace.subscribe, At-least-once delivery, Delete is the acknowledgement (+9 more)

### Community 44 - "Per-Peer Key Wrapping"
Cohesion: 0.15
Nodes (17): deriveWorkspaceKey (crypto.ts:68), Encryption never becomes optional, The enrolled-but-deaf state, Enrollment proof (HMAC over workspace, peerId, publicKey), Era key, Why frames are left alone, Invariant 6 (no new dependencies), Joining and removing a peer (+9 more)

### Community 45 - "Transport Config Fields"
Cohesion: 0.13
Nodes (17): ddrop init --github <owner>/<repo>, filesystem.pollIntervalMs, filesystem.root, filesystem transport, Authentication delegated to gh (no token seen), github.createIfMissing, github.ghPath, github.private (+9 more)

### Community 46 - "Retry & Policy Config Fields"
Cohesion: 0.14
Nodes (17): workspace.policy, policy.fallback, policy.primary, retry block, retry.factor, retry.initialDelayMs, retry.jitter, retry.maxDelayMs (+9 more)

### Community 47 - "Message Ids & Test Stores"
Cohesion: 0.15
Nodes (10): createMessageId(), encodeWrappedKey(), messageId(), MutableStore, plantBeacon(), planted(), registration(), ADR-0006 (+2 more)

### Community 48 - "Secrets & Init Commands"
Cohesion: 0.14
Nodes (16): ddrop init, ddrop init --secret <value|->, ddrop keygen, DEADDROP_SECRET, ${env:NAME} reference expansion, ${file:PATH} reference expansion, Path resolution rule, REPLACE-ME placeholder (+8 more)

### Community 49 - "Failover Scenario"
Cohesion: 0.14
Nodes (4): absent_from(), announced_on(), announced_on_both(), 07-failover.sh script

### Community 50 - "Conformance Contract Rules"
Cohesion: 0.15
Nodes (15): custom-transport reports 19/19 conformance cases, peerId must differ or two runtimes share a mailbox and fail DECODE_FAILED, custom-transport example, ddrop trace, @fyrlabs/dead-drop/core entry point, peerId, Waiting for each peer table (with scan-cap lower bound note), Every byte value survives a round trip (+7 more)

### Community 51 - "Project Positioning"
Cohesion: 0.14
Nodes (15): Git transport pays for a clone after restart; seconds, not milliseconds, AES-256-GCM workspace encryption, Storage holds ciphertext only, envelope header included, dead-drop runtime, docs/architecture.md, docs/operations.md, docs/testing.md, docs/vision.md (+7 more)

### Community 52 - "Reaper Design Rationale"
Cohesion: 0.19
Nodes (15): Commit history as the only record a message existed, Absence of a beacon as the liveness signal, A stale beacon is kept while its owner still has mail, Stale presence beacon reaper (aggressive), discoverPeers({ includeStale: true }) / listBeacons, Orphaned inbox object reaper (conservative), inboxOrphanMs horizon, Invariant 9 (keys carry names in the clear by design) (+7 more)

### Community 53 - "Runtime Package Manifest"
Cohesion: 0.13
Nodes (14): bin, ddrop, dead-drop, bugs, description, engines, node, homepage (+6 more)

### Community 54 - "CLI Formatting & Trace Output"
Cohesion: 0.20
Nodes (14): cliLogger, defaultIo, defaultPeerId(), formatBytes(), init(), joinHint(), pad(), printSpanTree() (+6 more)

### Community 55 - "Git Workdir Lock"
Cohesion: 0.27
Nodes (10): DirLock, isDirLockFree(), isRunning(), lockPathFor(), OwnerRecord, readOwner(), releaseIfOurs(), sweepAbandoned() (+2 more)

### Community 56 - "Demo & Examples Setup"
Cohesion: 0.14
Nodes (14): docs/configuration.md matches runtime/config.ts field for field, Config paths resolve against the config file's directory, demo/use <transport> config switcher, ddrop start runs in the foreground (hence three terminals), Transport cost table: filesystem ms, git ~1s, github tens of seconds, Examples use the filesystem transport so nothing needs credentials or a network, ddrop init, ddrop start (+6 more)

### Community 57 - "Encryption & Object Key Layout"
Cohesion: 0.16
Nodes (14): Invariant 9: the transport is hostile storage for frame contents, Invariant 5: a message id is its trace id, Correction of the 'never in clear text' claim (0.2.3, 0.4.0), ${file:PATH} and ${env:NAME} config interpolation (0.4.0), init writes a config that works (0.4.0), Observability: JSON logs with redaction, Prometheus metrics, tracing (0.1.0), Nothing secret reaches a log, docs/security-model.md (+6 more)

### Community 58 - "Proxy Mode & Correlation"
Cohesion: 0.18
Nodes (14): Any peer may compact, no election, ADR 0006: any member may reap an orphaned inbox, on age plus absence, Ephemeral <configured>-c<pid-hex> connect peers, queues() diagnostic (runtime/workspace.ts:575), Rejected: doing nothing because compaction bounds the repository, Rejected: an owner or elected reaper, Rejected: reaping by peer-id shape, Rejected: sender-side expiry (+6 more)

### Community 59 - "Git Transport Config"
Cohesion: 0.18
Nodes (14): Data branch compaction with compare-and-swap lease, git.authorName / git.authorEmail, git.batchWindowMs, git.branch (deaddrop-data orphan branch), git.compactAfterCommits, git.freshnessMs, git.gitPath, git.prefix (+6 more)

### Community 60 - "Build Commands & Verify Gate"
Cohesion: 0.15
Nodes (13): Angular commit convention, dead-drop transport-agnostic runtime, git binary required, no network or credentials, npm run build (tsc --build), npm run format / format:check, npm run verify (the gate), npm test, Renaming a symbol can reflow unrelated files (+5 more)

### Community 61 - "Reference Transport ADR"
Cohesion: 0.18
Nodes (13): Transport conformance suite, Filesystem transport (~300 lines, atomic writes, polling watcher), capabilities.kind === 'store', ADR 0002: filesystem is the reference transport, not GitHub, End-to-end suite over two runtimes and one directory, Filesystem as the reference transport, GitHub transport as a thin layer over git, GitHub cannot be tested in CI (+5 more)

### Community 62 - "Control Plane Socket ADR"
Cohesion: 0.23
Nodes (13): ADR 0003: the control plane is a Unix socket, not localhost TCP, Cross-container clients must mount the socket, Local runtime control plane, Named pipe on Windows, Future opt-in networked listener, Unix domain socket at mode 0600, ADR 0004: ddrop dashboard binds a TCP port and is a control-socket client, Dashboard as another control-socket consumer (+5 more)

### Community 65 - "Release E2E Verification"
Cohesion: 0.17
Nodes (12): e2e/run.sh fast, e2e/run.sh live <owner>/<repo>, After-publishing verification checks, e2e/run.sh fast --npm <version> against the published package, npm provenance shown on the package page, e2e/run.sh fast step, The live tier needs credentials, so it stays a human decision, id-token: write permission (provenance) (+4 more)

### Community 66 - "Transport Resilience History"
Cohesion: 0.17
Nodes (12): Invariant 1: nothing above the transport manager may name a transport, eslint no-restricted-imports replaced package-boundary layering (0.2.0), Failover no longer backs off in front of an open breaker (0.3.0), healthIntervalMs (0.5.0), Non-retryable health failures logged at error level (0.2.3), polling and policy validated at config load (0.12.0), REPLACE-ME placeholder fails at start-up (0.4.0), A transport that failed to start once can recover (0.3.1) (+4 more)

### Community 67 - "Secret Handling & Roadmap"
Cohesion: 0.21
Nodes (12): ddrop keygen, ${env:NAME} config expansion, Logger redaction, Where secrets live, Inline credential stripping from git urls, 32-byte workspace secret, Two-machine manual walkthrough, What exists today (+4 more)

### Community 68 - "custom-transport Example Manifest"
Cohesion: 0.17
Nodes (11): dependencies, @fyrlabs/dead-drop, @fyrlabs/dead-drop-transport-sdk, @fyrlabs/dead-drop, @fyrlabs/dead-drop-transport-sdk, name, private, scripts (+3 more)

### Community 69 - "express-proxy Example Manifest"
Cohesion: 0.17
Nodes (11): dependencies, @fyrlabs/dead-drop, @fyrlabs/dead-drop-transport-sdk, @fyrlabs/dead-drop, @fyrlabs/dead-drop-transport-sdk, name, private, scripts (+3 more)

### Community 70 - "sdk-rpc Example Manifest"
Cohesion: 0.17
Nodes (11): dependencies, @fyrlabs/dead-drop, @fyrlabs/dead-drop-transport-sdk, @fyrlabs/dead-drop, @fyrlabs/dead-drop-transport-sdk, name, private, scripts (+3 more)

### Community 71 - "Id Generation"
Cohesion: 0.32
Nodes (10): bumpRandom(), createGroupId(), createId(), createPrefixedId(), createRequestId(), encodeRandom(), encodeTime(), idTime() (+2 more)

### Community 72 - "Git Transport Tests"
Cohesion: 0.26
Nodes (10): gitTransport, bareRemote(), bytes(), commitCount(), create(), dirs, execFileAsync, opened (+2 more)

### Community 73 - "Versioning & Release Rules"
Cohesion: 0.18
Nodes (11): npm bin path must not start with ./, Docs change in the same commit as behaviour, The two packages do not share a version, Invariant 7: transport-sdk is the only stable public contract, transport-sdk 1.1.0 nested prefix listing check, Keep a Changelog and semantic versioning, ddrop queues reads object keys only (0.6.0), Release workflow skips an already-published package (0.2.0) (+3 more)

### Community 74 - "Error Model & Clock Rules"
Cohesion: 0.18
Nodes (11): Injected Clock, never Date.now or bare timers, DeadDropError with stable code and honest retryable flag, Invariant 10: DeadDropError identity is a registry symbol, never instanceof, Never pin transport-sdk to an exact version, Error model moved into transport-sdk (0.2.0, breaking), Multiple transports with health scoring, jittered retry, breaking and failover (0.1.0), Missing exposure returns NOT_FOUND 404 instead of DECODE_FAILED 500 (0.2.6), Request timeout bounds the whole request (0.3.0) (+3 more)

### Community 75 - "Two-Peer Demo"
Cohesion: 0.24
Nodes (11): Two-peer demo, peer-a (exposes demo/site), peer-b (connects on 127.0.0.1:8099), Reset avoids globs because zsh aborts on a non-matching pattern, demo/site plain directory exposure, Demo page served through dead-drop, ddrop connect, ddrop discover (+3 more)

### Community 76 - "Mailbox Delivery Mechanisms"
Cohesion: 0.24
Nodes (11): Adaptive polling, Broadcast topics with a resume cursor, Dead letters, Deduplication, Delete-as-acknowledgement, Mailbox engine in @fyrlabs/dead-drop/core, Redelivery with backoff, Structured control-plane data (/peers, /transports, /status, /queues, logs, traces, metrics) (+3 more)

### Community 77 - "Socket Discovery & Dashboard Docs"
Cohesion: 0.22
Nodes (11): ADR 0004: dashboard binds TCP and holds no runtime, Config file discovery order, controlSocket, 104-byte socket path fallback, Dashboard binds 127.0.0.1 and checks Host, Dashboard is read-only, Dashboard starts no runtime, ddrop dashboard (+3 more)

### Community 79 - "Test Fixtures & Faulty Transport"
Cohesion: 0.29
Nodes (6): createLogger(), FaultyStoreConfig, faultyTransport(), harness(), manager(), TransportRegistration

### Community 80 - "Filesystem Conformance Tests"
Cohesion: 0.33
Nodes (8): directoryExists(), context(), create(), makeRoot(), roots, store(), registerConformanceTests(), TestFramework

### Community 81 - "Runtime tsconfig"
Cohesion: 0.18
Nodes (10): compilerOptions, outDir, rootDir, exclude, extends, include, src/**/*, src/**/*.test.ts (+2 more)

### Community 82 - "Two-Package Layout"
Cohesion: 0.20
Nodes (10): custom-transport conformance example (19/19 cases), Two-package npm workspace, packages/transport-sdk, Layer subpath exports of @fyrlabs/dead-drop, src/transports/* (filesystem, git, github, memory), Plugin contract and framework-agnostic conformance suite (0.1.0), Consolidation from ten packages to two (0.2.0, breaking), Transports are published outside this repository (+2 more)

### Community 83 - "Discovery & Proxy History"
Cohesion: 0.22
Nodes (10): discover distinguishes unreachable from empty (0.6.0), expose prints the peer's connect command (0.12.0), inboxOrphanMs orphan mail reaping (0.10.0), Presence beacons no longer pile up on a slow transport (0.3.1), presenceIntervalMs (0.5.0), Proxy mode (0.1.0), Runtime starts even when no transport is reachable (0.3.1), ddrop connect (+2 more)

### Community 84 - "Hostile Storage & Leaks"
Cohesion: 0.22
Nodes (10): Transport treated as hostile storage, Documented leak: unprotected metadata, Leak: peer existence and activity, Leak: sizes, counts and timing, Cleartext-scan assertion over transport bytes, End-to-end suite (two runtimes, real transport), Walkthrough step 8: verify the transport cannot read traffic, Say what is true (+2 more)

### Community 86 - "Key Validation Helpers"
Cohesion: 0.31
Nodes (7): acmeTransport, cases, assertValidKey(), assertValidPrefix(), isValidKey(), joinKey(), RESERVED_SEGMENTS

### Community 87 - "Package Subpath Exports"
Cohesion: 0.20
Nodes (10): default, exports, ./package.json, ./runtime, ./sdk, default, types, default (+2 more)

### Community 88 - "Tracer Spans"
Cohesion: 0.24
Nodes (5): ActiveSpan, NOOP_SPAN, SpanStatus, TracerOptions, withSpan()

### Community 90 - "Transport SDK tsconfig"
Cohesion: 0.20
Nodes (9): compilerOptions, outDir, rootDir, exclude, extends, include, src/**/*, src/**/*.test.ts (+1 more)

### Community 91 - "Git Push Verification Traps"
Cohesion: 0.28
Nodes (9): git push exit 0 is not proof anything was published, git rev-parse --git-dir answers for the enclosing repository, A git working tree holds no dead-drop bookkeeping, compactAfterCommits data-branch compaction (0.8.0), Second runtime clones into <workDir>.peers/ (0.2.5), A push counts as published only once the commit is on the remote-tracking branch (0.2.4), git transport no longer takes over an enclosing repository (0.3.1), deaddrop-data orphan branch (+1 more)

### Community 92 - "Dashboard Runtime Hazards"
Cohesion: 0.25
Nodes (9): git transport (second transport), Local bare repository test fixture, Push-race path, ddrop connect (runtime constructor), Explicit --port with loud EADDRINUSE failure, Dashboard constructs no DeadDropRuntime, Phantom peers from ephemeral client identities, Unbounded beacon commits on git and github (+1 more)

### Community 93 - "Test Strategy Details"
Cohesion: 0.22
Nodes (9): Gzip bomb fails as PAYLOAD_TOO_LARGE, Injected Clock and TestClock.advance, Manual verification checklist, peerId collision trap, Platform gaps needing a human, 07-failover.sh, DeadDropError code table, health() and TransportHealth (+1 more)

### Community 94 - "Config & Socket Path Resolution"
Cohesion: 0.28
Nodes (7): configCandidates(), findConfigPath(), resolveConfig(), socketPathFor(), loadRuntimeConfig(), defaultSocketPath(), created

### Community 95 - "Transport Definition API"
Cohesion: 0.28
Nodes (6): ID_PATTERN, assertValidDefinition(), defineTransport(), registrationName(), TransportDefinition, TransportFactory

### Community 97 - "Examples CI Integration"
Cohesion: 0.29
Nodes (8): Run the examples if the change touches them, Run the examples step, Examples index, express-proxy example, sdk-rpc example, ddrop call, @fyrlabs/dead-drop/runtime entry point, workspace.service (embedded runtime RPC)

### Community 98 - "Two Transport Kinds ADR"
Cohesion: 0.29
Nodes (8): ADR 0001: two transport kinds instead of one interface, Chunking and reassembly, capabilities.kind === 'native', Intended backends are all object stores, Open plugin ecosystem goal, Reinvented delivery semantics per adapter, StoreBackedTransport base class (rejected alternative), Original single Transport interface (connect/send/receive/health/close)

### Community 99 - "Enrollment Token Model"
Cohesion: 0.29
Nodes (8): allowPeers guardrail, Reaping grants no new privilege, ADR 0007: the shared secret becomes an enrollment token, per-era keys wrapped per peer, The secret as an enrollment token, Rejected: mandatory out-of-band fingerprint approval, Rejected: trust on first use, no secret at all, Opt-in strict tier: enrollment.requireApproval, The 32-byte shared workspace secret

### Community 100 - "Transport Kinds & Polling"
Cohesion: 0.29
Nodes (8): A partial view is not a view, Shared reaper throttle on the presence interval, Adapters (filesystem, git, github, memory, third-party), Adaptive polling with watch interrupt, ADR 0001 (store and native transports), native transport kind, Selection governs writes only, store transport kind

### Community 101 - "Identity vs From Authorization"
Cohesion: 0.29
Nodes (8): allowPeers is a guardrail, not a security boundary, DEADDROP_PEER_ID, exposure.allowPeers, workspace.peerId, Authorise on identity, never on from, context.from, context.identity, senderIdentity(envelope)

### Community 102 - "Shared Secret Threat Model"
Cohesion: 0.36
Nodes (8): ADR 0007: per-peer key wrapping, Two-stage key rotation, Threat: any member reads every message, Threat: any member can impersonate any member, Per-peer keypairs and signed envelopes (not built), Revocation only by rotating the secret, Identity is a shared secret, 06-key-rotation.sh

### Community 103 - "Frame Encryption Details"
Cohesion: 0.32
Nodes (8): AES-256-GCM with per-frame random IV, Frame preamble: authenticated, not encrypted, DedupeStore, Whole envelope encrypted, HKDF-SHA256 key derivation, Key id (8 hex of SHA-256), Message and request TTL, Replay defence

### Community 104 - "Transport Authoring Checklist"
Cohesion: 0.36
Nodes (8): Transport conformance suite run per transport, 01-configuration.sh, Declared capabilities, registerConformanceTests, defineTransport, maxPayloadBytes and chunk sizing, parseConfig, Pre-publish checklist

### Community 105 - "Package Keywords"
Cohesion: 0.25
Nodes (8): keywords, distributed, git, local-first, messaging, nat-traversal, rpc, transport

### Community 106 - "Runtime README Surface"
Cohesion: 0.25
Nodes (8): ddrop transport list | health, defineTransport (as used from the runtime README), docs/writing-a-transport.md, memory transport, Runtime supplies framing, chunking, acks, retries, dedup, dead-lettering, adaptive polling, Store transport contract: put, get, list, delete, Now section: waiting, in flight, retrying, peers, transports up, poll interval, Transports table: kind, health, breaker, score, latency, errors

### Community 108 - "E2E Suite Policy"
Cohesion: 0.29
Nodes (7): e2e scenario suite (run.sh, lib.sh, fast/ and live/), Live GitHub walkthrough before tagging, A test that would have caught the bug beats a test that covers the fix, Throwaway private GitHub repos for testing, Two-tier e2e suite: fast and live (0.2.6), Tests prove behaviour, not coverage, docs/testing.md

### Community 109 - "TTL From Key Design"
Cohesion: 0.38
Nodes (7): Age comes from the key, never the payload, idTime / parseInboxKey, isExpired / per-message TTL, core/mailbox.ts delivery loop, reapTopics (mailbox.ts:700), Rejected: honouring real per-message TTL by decrypting candidates, Mailbox engine

### Community 110 - "Runtime Config API"
Cohesion: 0.29
Nodes (7): CONFIG_INVALID start-up error, parseRuntimeConfig, Configuration reference (deaddrop.config.json), Operations runbook, DeadDropRuntime, @fyrlabs/dead-drop/runtime, RuntimeConfig

### Community 112 - "Transport Import Guard Test"
Cohesion: 0.29
Nodes (3): manifest, require, transportsDir

### Community 113 - "Demo Secret Handling"
Cohesion: 0.33
Nodes (6): No secrets, tokens or absolute local paths in the diff, demo/env.sh (defines ddrop, loads the shared secret), demo/.secret (gitignored shared secret), Every terminal needs the secret; config parse resolves ${env:DEADDROP_SECRET} first, ddrop keygen, One 32-byte workspace secret is membership

### Community 114 - "At-Least-Once Delivery"
Cohesion: 0.33
Nodes (6): Invariant 4: at-least-once delivery, best-effort ordering per recipient, At-least-once delivery machinery over plain object storage (0.1.0), Duplicates are suppressed, not prevented, Responses buffered whole and capped at 32 MiB, workspace concurrency setting (0.5.0), docs/guarantees.md

### Community 115 - "Live Tier Testing"
Cohesion: 0.33
Nodes (6): CAN/CANNOT pairing requirement, e2e/run.sh, git push exit-code bug found only live, Live tier, Scenario suite, Roadmap: a token path for GitHub

### Community 116 - "Problem Statement & Non-Goals"
Cohesion: 0.33
Nodes (6): Measure the round trip to set requestTimeoutMs, Non-goal: not a message broker, Non-goal: not a way around your security policy, Non-goal: not a service mesh, The problem: the network is the obstacle, Existing shared infrastructure becomes the transport

### Community 119 - "Key Rotation Scenario"
Cohesion: 0.40
Nodes (3): grep_discover(), never_sees_keeper(), 06-key-rotation.sh script

### Community 121 - "Prettier Config"
Cohesion: 0.33
Nodes (5): arrowParens, printWidth, semi, singleQuote, trailingComma

### Community 122 - "Naming & Release Rules"
Cohesion: 0.40
Nodes (5): Invariant 8: never reintroduce the name Bridge, Releasing does not need permission, A tag is not a release, .github/RELEASE_CHECKLIST.md, .github/RELEASE_TEMPLATE.md

### Community 123 - "Rejected Control Plane Options"
Cohesion: 0.40
Nodes (5): Filesystem permissions as the access control mechanism, Localhost TCP control plane (rejected), Token authentication scheme (rejected), Browser-reachable localhost threat (CSRF, Origin, DNS rebinding), Read-only constraint on the dashboard API

### Community 124 - "Published Files List"
Cohesion: 0.40
Nodes (5): files, dist, LICENSE, README.md, static

### Community 125 - "CLI IO Interface"
Cohesion: 0.40
Nodes (3): CliIo, dashboard(), dashboardPort()

### Community 127 - "Dependency Discipline"
Cohesion: 0.50
Nodes (4): Workspace hoisting hides missing dependencies, Invariant 6: built-in transports may import only node builtins or declared dependencies, No dependencies without a strong reason, Node.js 20.11 or newer

### Community 128 - "Socket Path Limits"
Cohesion: 0.50
Nodes (4): defaultSocketPath and the 104-byte Unix socket cap, Windows path and named-pipe trap, Hashed short socket path under temp (0.2.1), --json output and runtime discovery through config

### Community 129 - "Store vs Native Kinds"
Cohesion: 0.67
Nodes (4): ADR 0001: store and native transports, Delivery is implemented once, History: the rejected send/receive/acknowledge interface, Native transports (kind: 'native')

### Community 131 - "Repository Metadata"
Cohesion: 0.50
Nodes (4): repository, directory, type, url

### Community 132 - "Minor Cluster 132"
Cohesion: 0.67
Nodes (3): docs/adr decision records, docs/vision.md, Not a message broker

### Community 133 - "Minor Cluster 133"
Cohesion: 0.67
Nodes (3): parallel policy actually fans out (0.11.0), Every peer polls all the transports it has, Transport policy: parallel mode

### Community 135 - "Minor Cluster 135"
Cohesion: 0.67
Nodes (3): Object paths name the workspace and peers on purpose; contents are ciphertext, docs/security-model.md, Unprotected: message sizes, timing, mailbox object keys

### Community 136 - "Minor Cluster 136"
Cohesion: 0.67
Nodes (3): Invariant 9: names are in the clear in store object keys, Explicit 127.0.0.1 bind, never 0.0.0.0, Workspace metadata disclosure through the open port

### Community 137 - "Minor Cluster 137"
Cohesion: 0.67
Nodes (3): default, types, ./cli

### Community 138 - "Minor Cluster 138"
Cohesion: 0.67
Nodes (3): default, types, ./core

### Community 139 - "Minor Cluster 139"
Cohesion: 0.67
Nodes (3): dependencies, @fyrlabs/dead-drop-transport-sdk, @fyrlabs/dead-drop-transport-sdk

### Community 140 - "Minor Cluster 140"
Cohesion: 0.67
Nodes (3): ./protocol, default, types

### Community 141 - "Minor Cluster 141"
Cohesion: 0.67
Nodes (3): ./transports/filesystem, default, types

### Community 142 - "Minor Cluster 142"
Cohesion: 0.67
Nodes (3): ./transports/git, default, types

### Community 143 - "Minor Cluster 143"
Cohesion: 0.67
Nodes (3): ./transports/github, default, types

### Community 144 - "Minor Cluster 144"
Cohesion: 0.67
Nodes (3): ./transports/memory, default, types

## Ambiguous Edges - Review These
- `Invariant 10: DeadDropError identity is a registry symbol, never instanceof` → `AGENTS.md as the single source of repository instructions`  [AMBIGUOUS]
  CLAUDE.md · relation: references
- `Filesystem as the reference transport` → `Opening a browser is a convenience, not a dependency`  [AMBIGUOUS]
  docs/adr/0004-dashboard-binds-tcp-and-holds-no-runtime.md · relation: conceptually_related_to
- `Future opt-in networked listener` → `ddrop dashboard command`  [AMBIGUOUS]
  docs/adr/0003-unix-socket-control-plane.md · relation: conceptually_related_to
- `Workspace.reap()` → `Nothing above the transport manager names a transport`  [AMBIGUOUS]
  docs/architecture.md · relation: conceptually_related_to
- `Stale beacon reaping` → `At-least-once delivery`  [AMBIGUOUS]
  docs/configuration.md · relation: conceptually_related_to
- `peerId collision trap` → `DeadDropError code table`  [AMBIGUOUS]
  docs/testing.md · relation: conceptually_related_to
- `Platform gaps needing a human` → `Probe something that can genuinely fail`  [AMBIGUOUS]
  docs/writing-a-transport.md · relation: conceptually_related_to
- `list treats a prefix as a prefix, not a substring` → `Waiting for each peer table (with scan-cap lower bound note)`  [AMBIGUOUS]
  packages/dead-drop/static/index.html · relation: conceptually_related_to
- `Transport cost table: filesystem ms, git ~1s, github tens of seconds` → `Polls every 5s while the tab is visible`  [AMBIGUOUS]
  packages/dead-drop/static/index.html · relation: conceptually_related_to

## Knowledge Gaps
- **477 isolated node(s):** `semi`, `singleQuote`, `printWidth`, `trailingComma`, `arrowParens` (+472 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Invariant 10: DeadDropError identity is a registry symbol, never instanceof` and `AGENTS.md as the single source of repository instructions`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Filesystem as the reference transport` and `Opening a browser is a convenience, not a dependency`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Future opt-in networked listener` and `ddrop dashboard command`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Workspace.reap()` and `Nothing above the transport manager names a transport`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Stale beacon reaping` and `At-least-once delivery`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `peerId collision trap` and `DeadDropError code table`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Platform gaps needing a human` and `Probe something that can genuinely fail`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._