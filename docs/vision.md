# Vision

Where dead-drop is going, and what it refuses to become. For how it works today, read [architecture.md](architecture.md).

## The problem

Two machines need to talk. The network between them is the obstacle: a laptop behind NAT, a locked-down corporate environment, a CI runner, an air-gapped review box that can still reach a git remote. The usual answer is to deploy something, a broker, a tunnel, a relay, a public endpoint, and the deployment is more expensive than the problem.

But those machines almost always already share something: a git repository, a synced folder, an object store, a wiki. Infrastructure that exists, is already authenticated, and is already allowed through the firewall.

dead-drop turns that shared thing into a transport.

## Philosophy

**Transport is an implementation detail.** Applications talk to their local runtime and nothing else. Swapping GitHub for a shared folder is a config change, never a code change. Nothing above the transport manager is allowed to name a transport, because if it could, transport independence would be a slogan rather than a property.

**Delivery is implemented once.** Most backends people want are object stores with no delivery semantics of their own. Asking every adapter author to reinvent polling, acknowledgement, deduplication and redelivery would give us a dozen subtly different sets of delivery bugs in packages we do not control. So a store adapter implements four methods and the runtime supplies the rest. See [ADR 0001](adr/0001-store-and-native-transports.md).

**Existing applications should not have to change.** Proxy mode exposes a server that has no idea dead-drop exists. The SDK is for applications that want more, not a tax on applications that want less.

**Say what is true.** Delivery is at-least-once and ordering is best-effort per recipient, stated plainly in [guarantees.md](guarantees.md) rather than buried. The transport is treated as hostile storage, and [security-model.md](security-model.md) says what is not protected as clearly as what is.

## What exists today

Four transports: filesystem, git, github and memory. Encryption, chunking, compression, retries, circuit breaking, failover, deduplication, health-based routing, structured logs, Prometheus metrics and tracing. Proxy mode and static exposures. A plugin contract stable enough for third parties to build against.

## Where it goes next

**More transports, as separate packages.** S3-compatible storage, OneDrive and SharePoint are the obvious gaps. GitLab, Bitbucket and Azure DevOps already work through the git transport by remote url; they earn dedicated packages only if their APIs offer something git does not.

**A token path for GitHub.** Today authentication is delegated entirely to `gh`. A REST path behind the existing `GhClient` seam would remove that dependency for environments where installing `gh` is the hard part.

**Streaming.** A response is buffered whole today and capped at 32 MiB. Large payloads should stream.

**A plugin ecosystem.** The measure of success is a transport written by someone who has never read this repository's internals, passing the conformance suite on the first try.

## Non-goals

**Not a message broker.** A round trip over a git remote costs seconds, not milliseconds. If you have Kafka, use Kafka. dead-drop is for the case where standing up infrastructure is the expensive part, not for throughput.

**Not a way around your security policy.** dead-drop moves data through channels you are already authorised to use. It is not a tunnel for getting data somewhere it is not allowed to go, and features whose main purpose would be evading controls do not belong here.

**Not a service mesh.** No competition with Kubernetes, no ambitions on service discovery at scale, no sidecars.

**Not a database.** The transport holds messages in flight, with retention and a reaper. It is not storage you should query.

## History

An earlier design sketch specified a single `send`/`receive`/`acknowledge` transport interface. Implementation showed it was the wrong shape for the backends it targeted, and it was replaced by the two-kind contract. The reasoning is preserved in [ADR 0001](adr/0001-store-and-native-transports.md); decision records under [docs/adr](adr/) carry any later deviation.
