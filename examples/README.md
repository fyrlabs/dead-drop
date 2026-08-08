# Examples

Each example is runnable and self-contained. They use the filesystem transport so nothing needs credentials or a network.

| Example | Shows |
| --- | --- |
| [express-proxy](express-proxy/) | Exposing an unmodified Express app and consuming it from another runtime. |
| [sdk-rpc](sdk-rpc/) | Services, RPC and publish/subscribe with an embedded runtime. |
| [custom-transport](custom-transport/) | Writing a transport in ~60 lines and running the conformance suite against it. |

```bash
npm install          # from the repository root
node examples/express-proxy/index.js
```
