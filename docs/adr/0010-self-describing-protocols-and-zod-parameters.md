# Protocol packages are self-describing and compose through injected dependencies

A Protocol package exports top-level self-describing `@Protocol` classes; the composition root supplies selected modules, and Registry registers their Protocol exports and recursively injects declared dependencies. Core owns framework contracts, simulator owns trace mechanics, Protocol packages own ABI semantics, Receipts, and protocol-exclusive deployments, `@themoss/erc` stays address-free, core owns the shared Monad Runtime and rejects non-143 RPCs, system owns shared verified asset constants, and MCP server owns transport; dynamic addresses come from chain state and adding a Protocol changes only its package and composition root. Capability and Query inputs use `{ type, description }`, separating a reusable context-free Zod value contract from the field's purpose and exposing the generated JSON-safe schema through `load`.

Protocol classes compose through declared `protocols` dependencies and typed injected fields. A decorated Protocol cannot extend another decorated Protocol; Registry rejects that inheritance so Receipt-only instances never execute a parent Protocol's Runtime-injecting constructor.

A Protocol whose contract identity is dynamic declares an optional binding schema instead of repeating that identity in every method's parameters. The schema pairs a parameter declaration map with a function deriving the instance's contract configs from the validated binding, and its TypeScript binding type is derived from the same schema so the two cannot drift. Both halves are synchronous and externally pure: core parses the schema with Zod's synchronous parse, which rejects an async refinement outright, and calls the derivation exactly once per instance. A malformed binding therefore fails before any Protocol method and before any RPC. Fixed contracts keep the existing `contracts` address field; binding does not rename it, and a derivation that shadows a fixed contract key is rejected.

A declared parameterized dependency is injected as a `ProtocolFactory`, a non-callable object. Its `create` validates one binding, constructs that instance's Handles and returns an independent Registry-managed reference; nothing is cached, so two calls carrying the same address produce two execution-scoped instances that cannot share state. Capability calls on that reference nest CapabilityNodes and Query calls return data, exactly as for an unbound dependency. Its separate `receipts` surface carries the pure parsers, which receive no Runtime, account, Handles or binding. A parameterized package exports a ready-to-use factory alias naming its Protocol, its binding schema and the parsers it publishes, rather than recovering any of that generically from the decorated class. Naming the parsers is a declaration: TypeScript cannot observe a decorator, so a wholesale structural map would also admit an undecorated helper that happens to return a `ReceiptResult`. Registry still keeps the last word at the call site, answering any name a surface cannot honestly serve with a named framework error instead of `undefined`.

`load` describes binding beside, and separately from, method params; `action` accepts it the same way; and a parameterized CapabilityNode serializes its canonical binding while an unbound one omits the field entirely. Wire-supplied nodes are re-checked against the Protocol they name before simulation, and binding draws on the same cumulative tree budgets as params. Receipt parsing neither receives nor trusts that binding: it is serialized so an SDK consumer can see which instance acted, not so a parser can read evidence from it.

Protocol metadata may declare fixed Package address labels independently of Handles. Registry renders them as `Package(Title Cased Slug:localName)` and validates the combined payload inside the Core-owned wrapper as a 1–32 character safe name. The composition root supplies Trusted token labels through the explicit Registry constructor option, rendered as `Trusted(name)`; Registry never discovers them by scanning ordinary Protocol exports. Within one catalog or Protocol, addresses and case-insensitive names are both unique.

## The Monad Runtime moved to core (2026-07-31)

An earlier revision (ADR 0006, since deleted) kept chain identity out of `core`
entirely: `createRuntime` took `chainId` as a required parameter and shipped no
chain data, so `@themoss/system` supplied both Monad defaults through
`monadRuntime()`. That separation is gone — `core` dropped the `chainId`
parameter and has verified chain 143 itself ever since, which left
`monadRuntime()` as a wrapper whose only remaining job was a default endpoint,
and left `143` declared in two packages.

`core` now owns the whole Runtime: `MONAD_CHAIN_ID` and `defaultRpcUrl()` (the
`MOSS_RPC_URL` override, the only place that reads the environment for an
endpoint). `createRuntime()` takes an optional `rpcUrl`, `monadRuntime()` is gone,
and `system` is what its name claims: shared verified constants plus the WMON
Protocol.

The override resolves per call rather than at module load, so a consumer that sets
the variable after importing core still affects later Runtimes and a test needs no
module-registry reset. A blank value counts as unset, because a workflow forwarding
the endpoint from a secret sets the variable to an empty string wherever that secret
is unavailable — every fork pull request, which receive no secrets. A non-blank
value that is not an http(s) URL is a misconfiguration and is rejected by name,
rather than falling back and surfacing later as a transport error.

This also removes a package-boundary problem rather than working around it.
`system` imports `ERC20` and `WETH9Abi` from `erc`, so an `erc` test that wanted
the shared endpoint could not import `system` without a cycle — a
devDependency-only cycle still reorders `pnpm -r build` and breaks system's dts
build. Every package already depends on `core`, so the endpoint is now reachable
from all of them directly.
