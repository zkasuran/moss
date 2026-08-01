---
"@themoss/core": minor
"@themoss/mcp-server": patch
---

Add Bound Protocol construction to Registry. A Protocol whose contract identity
is dynamic now declares a `bindingSchema` (parameter declarations plus a
synchronous derivation of that instance's contract configs) instead of repeating
the identity in every method's params, and its TypeScript binding type is derived
from that same schema.

A declared parameterized dependency is injected as a non-callable
`ProtocolFactory`. `create` validates one binding, assembles the instance's
Handles and returns an independent reference; nothing is cached, so two calls
carrying the same address produce two execution-scoped instances. Capability
calls on that reference nest CapabilityNodes and Query calls return data, while
the separate `receipts` surface carries only pure parsers with no Runtime,
account, Handles or binding.

`load` describes binding beside method params, `action` accepts it the same way,
and a parameterized CapabilityNode serializes its canonical binding while an
unbound one omits the field. Binding validation is synchronous throughout, so a
malformed binding fails before any Protocol method runs and before any RPC.
Wire-supplied nodes are re-checked against the Protocol they name before
simulation, and binding draws on the same cumulative tree budgets as params.
Unbound Protocols are unchanged.
