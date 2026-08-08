# Bridge --- Open-Source Architecture & Design Vision

**Status:** Vision / Architecture Proposal

## 1. Vision

Bridge is a local-first runtime and SDK for connecting applications
running on different machines through interchangeable transport
adapters.

The application should not know whether communication happens through
GitHub, GitLab, Bitbucket, OneDrive, SharePoint, a filesystem, S3, or a
custom backend.

``` text
Application
    |
    v
Bridge Runtime
    |
    v
Transport Adapter(s)
    |
    v
External Infrastructure
    |
    v
Transport Adapter(s)
    |
    v
Bridge Runtime
    |
    v
Application
```

The transport is an implementation detail. Bridge provides the
abstraction between an application and whatever infrastructure is
available to carry its data.

------------------------------------------------------------------------

## 2. Problem

Developers often want to share or connect applications without deploying
dedicated infrastructure.

Examples:

-   Share an existing Express API.
-   Share a Next.js application.
-   Share a static website.
-   Build a distributed CLI.
-   Connect two development environments.
-   Build experimental multi-machine applications.
-   Exchange events, RPC calls, or messages.

Traditional approaches require some combination of hosting, networking,
VPNs, public endpoints, brokers, firewall configuration, or
infrastructure management.

Bridge explores a different model:

``` text
Existing Application
        +
Bridge Runtime
        +
Existing External Infrastructure
```

------------------------------------------------------------------------

# 3. Core Principles

### Transport independence

Application code must never depend directly on GitHub, GitLab,
Bitbucket, or another transport.

``` ts
await bridge.request(...)
```

not:

``` ts
github.createIssue(...)
```

### Application independence

Existing applications should work with little or no modification.

``` bash
bridge expose --target http://localhost:3000
```

### Everything is pluggable

Extension points include:

-   transports
-   authentication
-   serialization
-   encryption
-   storage
-   caching
-   logging
-   metrics
-   monitoring
-   application adapters
-   discovery

### Multiple transports are first-class

A runtime may use multiple transports for:

-   failover
-   redundancy
-   capability matching
-   performance
-   migration
-   experimentation

``` text
                 +--> GitHub
                 |
Bridge ----------+--> GitLab
                 |
                 +--> Custom
```

### Observability by default

Every transport operation can automatically produce:

-   latency
-   throughput
-   payload size
-   retries
-   failures
-   rate-limit state
-   polling frequency
-   queue depth
-   cache behavior
-   failover events
-   transport health

------------------------------------------------------------------------

# 4. Architecture

``` text
+----------------------------------------------------------+
|                    User Application                      |
| Express / Next.js / React / CLI / Python / Go / etc.   |
+-----------------------------+----------------------------+
                              |
                    Local SDK / Adapter
                              |
                              v
+----------------------------------------------------------+
|                    Bridge Runtime                        |
|                                                          |
| +----------------+  +----------------+  +--------------+ |
| | Request Router |  | Event Engine   |  | Local Cache  | |
| +----------------+  +----------------+  +--------------+ |
|                                                          |
| +------------------------------------------------------+ |
| |                Transport Manager                     | |
| | Routing | Retry | Failover | Health | Scheduling     | |
| +------------------------------------------------------+ |
|                                                          |
| +----------------+  +----------------+  +--------------+ |
| | Logging        |  | Metrics        |  | Monitoring   | |
| +----------------+  +----------------+  +--------------+ |
+-----------------------------+----------------------------+
                              |
              +---------------+---------------+
              |               |               |
              v               v               v
        +-----------+   +-----------+   +-----------+
        | GitHub    |   | GitLab    |   | Custom    |
        | Adapter   |   | Adapter   |   | Adapter   |
        +-----------+   +-----------+   +-----------+
```

------------------------------------------------------------------------

# 5. Runtime Model

Bridge uses a one-runtime-per-machine model by default.

A runtime can host multiple isolated workspaces:

``` text
Bridge Runtime
|
+-- Workspace: project-a
|   +-- service: api
|   +-- service: web
|   +-- channel: events
|
+-- Workspace: project-b
|   +-- service: cli
|   +-- channel: commands
|
+-- Workspace: project-c
    +-- service: dashboard
```

This avoids a separate polling process for every application while
keeping projects logically isolated.

Different workspaces may use different transport configurations.

------------------------------------------------------------------------

# 6. Existing Application Exposure

The primary zero-code path is proxy mode.

Existing Express application:

``` text
localhost:3000
```

Run:

``` bash
bridge expose   --name my-api   --target http://localhost:3000
```

The flow becomes:

``` text
Viewer
  |
Bridge Runtime
  |
Transport
  |
Bridge Runtime
  |
http://localhost:3000
  |
Express
```

Express does not need Bridge-specific code.

Static sites can work similarly:

``` bash
bridge expose ./dist --name my-site
```

Dynamic applications such as Next.js can be exposed by targeting their
local server.

------------------------------------------------------------------------

# 7. Native SDK Mode

Applications that want Bridge-native features can optionally use the
SDK.

``` ts
const bridge = createClient({
  workspace: "my-project"
});

await bridge.publish("events", {
  type: "user.created",
  payload: user
});
```

RPC:

``` ts
const result = await bridge.call("math.add", {
  a: 10,
  b: 20
});
```

Service registration:

``` ts
bridge.service("math", {
  add({ a, b }) {
    return a + b;
  }
});
```

The SDK is optional. Existing applications should not need it merely to
be exposed.

------------------------------------------------------------------------

# 8. Request Sequence

``` text
Client        Bridge A       Transport       Bridge B       Target
  |              |               |              |             |
  | request      |               |              |             |
  |------------->|               |              |             |
  |              | request ID    |              |             |
  |              |-------------->|              |             |
  |              |               |  transport   |             |
  |              |               |------------->|             |
  |              |               |              |------------>|
  |              |               |              |   response  |
  |              |               |              |<------------|
  |              |               |<-------------|             |
  |              |<--------------|              |             |
  |<-------------|               |              |             |
```

The runtime owns correlation IDs, serialization, retries, timeout
handling, and telemetry.

------------------------------------------------------------------------

# 9. Failover Sequence

``` text
Bridge
  |
  | select Transport A
  v
Transport A
  |
  X unavailable
  |
  v
Transport Manager
  |
  | select Transport B
  v
Transport B
  |
  v
Remote Bridge
```

The application should not need to know that failover occurred.

------------------------------------------------------------------------

# 10. Transport Interface

A transport is a plugin.

Conceptually:

``` ts
export interface Transport {
  readonly id: string;

  connect(context: TransportContext): Promise<void>;

  send(message: TransportMessage): Promise<TransportResult>;

  receive(
    handler: (message: TransportMessage) => Promise<void>
  ): Promise<void>;

  health(): Promise<TransportHealth>;

  close(): Promise<void>;
}
```

The final API should be capability-oriented so a transport does not have
to pretend it supports features it cannot provide.

------------------------------------------------------------------------

# 11. Transport Capabilities

``` ts
interface TransportCapabilities {
  streaming: boolean;
  ordering: "none" | "partition" | "global";
  acknowledgements: boolean;
  binaryPayloads: boolean;
  maxPayloadSize?: number;
  delete: boolean;
  watch: boolean;
}
```

The Transport Manager can use capabilities during routing.

Example:

``` text
Request requires:
  binary payload
  acknowledgement
  low latency

Transport A:
  binary: yes
  ack: yes
  latency: low

Transport B:
  binary: no
  ack: no

=> Select Transport A
```

------------------------------------------------------------------------

# 12. Multiple Transport Strategy

A project may configure multiple adapters:

``` ts
createBridge({
  transports: [
    githubTransport(...),
    gitlabTransport(...),
    customTransport(...)
  ]
});
```

Supported strategies can include:

### Primary / Failover

``` text
GitHub -> GitLab -> Custom
```

### Parallel

``` text
          +-> GitHub
Message --+
          +-> GitLab
```

### Capability-based

Select a transport based on what the operation requires.

### Policy-based

``` ts
transportPolicy({
  primary: "github",
  fallback: ["gitlab", "onedrive"]
});
```

------------------------------------------------------------------------

# 13. User-Created Transport Plugins

This is a fundamental requirement.

**Users must be able to create transports without modifying, forking, or
merging code into the Bridge repository.**

A transport is a normal independently distributed package:

``` bash
npm install @bridge/transport-github
npm install @my-company/bridge-transport-foo
```

It can also come from:

-   a private package registry
-   a local package
-   a Git repository
-   another supported package source

Example:

``` ts
import { createBridge } from "@bridge/core";
import { myTransport } from "@company/bridge-transport-foo";

createBridge({
  transports: [
    myTransport(...)
  ]
});
```

No Bridge repository change is required.

------------------------------------------------------------------------

# 14. Transport Plugin Contract

Third-party authors implement the public Transport SDK:

``` ts
import { defineTransport } from "@bridge/transport-sdk";

export default defineTransport({
  id: "company-foo",

  capabilities: {
    streaming: false,
    ordering: "partition",
    acknowledgements: true,
    binaryPayloads: true
  },

  create(config) {
    return {
      async connect(context) {
        // initialize
      },

      async send(message) {
        // translate and send through external system
      },

      async receive(handler) {
        // poll or subscribe
      },

      async health() {
        return {
          status: "healthy"
        };
      },

      async close() {
        // cleanup
      }
    };
  }
});
```

Bridge owns the runtime lifecycle and observability around the adapter.
The adapter primarily translates between Bridge messages and its
external system.

------------------------------------------------------------------------

# 15. Plugin Architecture

``` text
                    Bridge Runtime
                         |
              +----------+----------+
              |                     |
        Plugin Manager         Core Services
              |                     |
     +--------+--------+       +----+----+
     |        |        |       |         |
 Transport  Auth     Storage  Logging  Metrics
     |
 +---+---------+---------+
 |             |         |
GitHub       GitLab    Custom
```

Possible package ecosystem:

``` text
@bridge/core
@bridge/runtime
@bridge/sdk
@bridge/transport-sdk

@bridge/transport-github
@bridge/transport-gitlab
@bridge/transport-bitbucket

@bridge/adapter-express
@bridge/adapter-static

@company/bridge-transport-internal
@company/bridge-auth-custom
```

Third-party packages live independently from the Bridge repository.

------------------------------------------------------------------------

# 16. Observability Architecture

Observability belongs at the runtime / transport boundary.

``` text
Application Request
       |
       v
Bridge Runtime
       |
       +--> Logger
       |
       +--> Metrics
       |
       +--> Tracer
       |
       v
Transport Manager
       |
       +--> Transport A
       |
       +--> Transport B
       |
       +--> Transport C
```

Example:

``` json
{
  "requestId": "req_123",
  "transport": "github",
  "operation": "send",
  "workspace": "project-a",
  "durationMs": 428,
  "payloadBytes": 1832,
  "attempt": 1,
  "status": "success"
}
```

The application should not have to manually instrument transport
operations.

------------------------------------------------------------------------

# 17. Transport Health

Each adapter reports health:

``` ts
interface TransportHealth {
  status: "healthy" | "degraded" | "unavailable";

  latencyMs?: number;

  rateLimit?: {
    remaining?: number;
    resetAt?: number;
  };

  lastSuccessfulOperation?: number;

  errorRate?: number;
}
```

The runtime can use this information for routing and failover.

Example:

``` text
GitHub
healthy
latency: 600ms

GitLab
healthy
latency: 120ms

OneDrive
degraded
latency: 2.4s
```

The application still sees:

``` ts
await bridge.call(...)
```

------------------------------------------------------------------------

# 18. Security Model

Security belongs in the protocol and runtime.

Core concepts:

-   identity
-   authentication
-   authorization
-   encryption
-   message integrity
-   replay protection
-   workspace isolation
-   secret management

Transport credentials should not be exposed to application code.

``` text
Application
     |
     | local API
     v
Bridge Runtime
     |
     | credentials
     v
Transport
```

------------------------------------------------------------------------

# 19. Workspace Isolation

A single runtime can host unrelated projects:

``` text
Runtime
|
+-- workspace-a
|     |
|     +-- project-a
|
+-- workspace-b
|     |
|     +-- project-b
|
+-- workspace-c
      |
      +-- project-c
```

A project should not automatically see another project's:

-   messages
-   credentials
-   transport configuration
-   logs
-   storage
-   peers

------------------------------------------------------------------------

# 20. Discovery

Bridge can expose transport-independent discovery:

``` bash
bridge discover
```

Conceptual result:

``` text
workspace: demo
service: api
peer: machine-42

capabilities:
  - http
  - rpc

status:
  healthy
```

The discovery mechanism should remain independent of any particular
transport.

------------------------------------------------------------------------

# 21. Local Runtime API

Applications communicate with the local runtime through a local-only
interface.

Possible mechanisms:

-   localhost HTTP
-   Unix domain socket
-   named pipe
-   platform-specific IPC

Preferred architecture:

``` text
Application
    |
    | Local IPC
    v
Bridge Runtime
```

This keeps transport credentials and transport logic outside application
processes.

------------------------------------------------------------------------

# 22. CLI

The CLI is a primary interface.

``` bash
bridge start
bridge expose --target http://localhost:3000 --name api
bridge expose ./dist --name website
bridge list
bridge status
bridge transport list
bridge transport health
bridge logs
bridge metrics
bridge connect api
```

------------------------------------------------------------------------

# 23. Reliability Model

Bridge assumes transports are unreliable.

Possible failures:

``` text
Transport unavailable
Remote machine unavailable
Application crashed
Network unavailable
Rate limit reached
Duplicate message
Late message
```

The runtime should support:

-   retries
-   exponential backoff
-   jitter
-   deduplication
-   idempotency keys
-   acknowledgements
-   dead-letter handling
-   local persistence
-   offline queues
-   timeout handling
-   circuit breakers

The default delivery guarantee should be **at-least-once**.

Exactly-once delivery should only be claimed when the underlying
protocol genuinely supports it.

------------------------------------------------------------------------

# 24. Performance Strategy

Bridge should optimize within the constraints of each transport.

Potential techniques:

-   local caching
-   batching
-   adaptive polling
-   long polling where supported
-   incremental synchronization
-   compression
-   payload deduplication
-   connection reuse
-   parallel operations
-   intelligent backoff
-   capability-aware routing

The project should never pretend that a GitHub transport is equivalent
to a low-latency message broker.

------------------------------------------------------------------------

# 25. Transport Selection

The runtime can score available transports using:

``` text
availability
latency
capabilities
rate-limit headroom
recent reliability
```

Example:

``` text
GitHub
  healthy
  latency: 500ms
  rate-limit: 90%

GitLab
  healthy
  latency: 150ms
  rate-limit: 98%

=> Prefer GitLab
```

This is an internal implementation decision. The application remains
transport-independent.

------------------------------------------------------------------------

# 26. Protocol Boundary

The most important architectural boundary is:

``` text
Application semantics
        |
        v
Bridge protocol
        |
        v
Transport semantics
```

For example:

``` text
HTTP GET /users
```

becomes a Bridge request envelope:

``` json
{
  "type": "request",
  "protocol": "http",
  "method": "GET",
  "path": "/users"
}
```

The GitHub adapter decides how to represent that message externally.

The GitHub representation must never leak into the application layer.

------------------------------------------------------------------------

# 27. Responsibilities

## Application

Owns:

-   business logic
-   application state
-   domain behavior
-   UI

## Bridge Runtime

Owns:

-   message IDs
-   correlation
-   routing
-   serialization
-   encryption
-   retries
-   timeouts
-   deduplication
-   transport selection
-   failover
-   telemetry
-   health
-   plugin lifecycle
-   local IPC

## Transport Adapter

Owns:

> How do I move a Bridge message through this external system?

It should not own application routing, application semantics, or
business logic.

------------------------------------------------------------------------

# 28. Project Structure

Possible Bridge monorepo:

``` text
bridge/
|
+-- packages/
|   +-- core/
|   +-- runtime/
|   +-- sdk/
|   +-- transport-sdk/
|   +-- protocol/
|   +-- cli/
|   |
|   +-- transports/
|       +-- github/
|       +-- gitlab/
|       +-- bitbucket/
|
+-- examples/
|   +-- express/
|   +-- nextjs/
|   +-- static-site/
|   +-- cli/
|
+-- docs/
|
+-- tests/
```

Third-party transports live outside this repository.

------------------------------------------------------------------------

# 29. Development Phases

## Phase 0 --- Protocol

Define:

-   message envelope
-   IDs
-   correlation
-   acknowledgement model
-   serialization
-   error model
-   capabilities

Do this before implementing many transports.

## Phase 1 --- Runtime

Implement:

-   local IPC
-   plugin loading
-   transport manager
-   lifecycle
-   logging
-   metrics
-   health

## Phase 2 --- First Transport

Build one complete transport implementation.

GitHub can be the experimental first adapter.

The goal is to validate the abstraction, not to maximize adapter count.

## Phase 3 --- Existing Application Exposure

Implement:

``` bash
bridge expose --target http://localhost:3000
```

Support HTTP and static files.

## Phase 4 --- Multiple Transports

Add several independent adapters and validate:

-   failover
-   capability selection
-   health
-   metrics

## Phase 5 --- Third-Party Plugin API

Stabilize:

``` ts
defineTransport(...)
```

Publish the Transport SDK.

Third-party developers can now create adapters without modifying Bridge.

## Phase 6 --- Native SDK

Add:

-   publish/subscribe
-   RPC
-   services
-   queues
-   events

------------------------------------------------------------------------

# 30. Success Criteria

A developer with an existing application should be able to:

``` bash
npm start
bridge expose --target http://localhost:3000
```

Another developer should be able to:

``` bash
bridge connect my-api
```

Neither developer needs to understand the underlying transport.

A developer building a custom transport should be able to:

``` bash
npm install @my-company/bridge-transport-foo
```

and configure it without changing Bridge source code.

A developer building a Bridge-native application should be able to:

``` ts
await bridge.publish(...)
await bridge.call(...)
bridge.subscribe(...)
```

without knowing how the message travels.

------------------------------------------------------------------------

# 31. Final Model

``` text
                    APPLICATION
                         |
                         v
                 +---------------+
                 | Bridge Runtime |
                 +---------------+
                         |
                 +-------+-------+
                 |               |
                 v               v
             Protocol        Transport
                 |               |
                 |       +-------+-------+
                 |       |       |       |
                 |     GitHub  GitLab  Custom
                 |       |       |       |
                 +-------+-------+-------+
                         |
                         v
                  EXTERNAL SYSTEM
```

Applications define **what they want to communicate**.

Bridge defines **how that communication is routed**.

Transport adapters define **how an external system carries it**.

That separation is the foundation of Bridge.

------------------------------------------------------------------------

# 32. Guiding Principle

> **Build the application. Bring the transport. Bridge connects them.**

The transport is replaceable.

The application is independent.

The runtime handles the complexity between them.

And the ecosystem remains open: anyone can build and distribute a
transport adapter without modifying or merging code into the Bridge
repository.
