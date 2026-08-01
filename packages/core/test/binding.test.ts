import { parseAbi, parseUnits } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  Address,
  type AddressValue,
  bindingSchema,
  Capability,
  type CapabilityNode,
  type Change,
  type Handle,
  type InferParams,
  type ReceiptResult as MossReceipt,
  type MossRuntime,
  type ParamsSpec,
  PositiveDecimalString,
  Protocol,
  type ProtocolFactory,
  type ProtocolRef,
  Query,
  Receipt,
  Registry,
  transaction,
} from "../src/index.js";

const VaultAbi = parseAbi([
  "function deposit() payable",
  "function balanceOf(address owner) view returns (uint256)",
]);

const VAULT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const VAULT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const FIXED = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;

/**
 * Every property read on this client is an attempted RPC. Binding validation
 * and Handle construction must not make one, so a malformed binding that
 * reached the chain would fail this suite loudly instead of passing quietly.
 */
const runtime: MossRuntime = {
  rpcUrl: "http://offline",
  client: new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol") return undefined;
        throw new Error(`unexpected RPC: client.${String(key)}`);
      },
    },
  ) as MossRuntime["client"],
};

/** Bound vault addresses in the order the fixture Capability actually used them. */
let used: string[] = [];

const vaultBinding = bindingSchema({
  params: {
    vault: { type: Address, description: "Vault contract this instance deposits into." },
  },
  contracts: ({ vault }) => ({ vault: { abi: VaultAbi, addr: vault } }),
});

const depositParams = {
  amount: { type: PositiveDecimalString, description: "Native MON to deposit." },
} satisfies ParamsSpec;

const noParams = {} satisfies ParamsSpec;

@Protocol({
  name: "boundvault",
  category: "token",
  description: "Fixture vault Protocol bound to one vault contract.",
  contracts: {},
  binding: vaultBinding,
})
class BoundVault {
  declare vault: Handle<typeof VaultAbi>;

  @Capability<BoundVault, typeof depositParams>({
    intent: "Deposit {amount} native MON into the bound vault",
    verb: "supply",
    params: depositParams,
    receipt: "depositReceipt",
    risk: ["fundOut"],
  })
  async deposit({ amount }: InferParams<typeof depositParams>) {
    used.push(this.vault.address);
    return [this.vault.deposit([], { value: parseUnits(amount, 18) })];
  }

  @Query({ intent: "Read which vault this instance is bound to", params: noParams })
  async boundVault() {
    return { vault: this.vault.address };
  }

  @Receipt()
  depositReceipt(changes: readonly Change[]): MossReceipt<{ operation: "supply" }> {
    if ("runtime" in this || "vault" in this) {
      throw new Error("Receipt instance must not expose Runtime or bound Handles");
    }
    return {
      kind: "receipt",
      outcome: { operation: "supply" },
      text: "Deposited into the bound vault",
      changes: changes.map((change) => ({
        kind: "change",
        change,
        data: { operation: "supply" },
        text: "Observed deposit change",
      })),
    };
  }
}

/** The alias a parameterized package exports for its consumers. */
type BoundVaultFactory = ProtocolFactory<BoundVault, typeof vaultBinding, "depositReceipt">;

const routeParams = {
  first: { type: Address, description: "Vault that receives the first deposit." },
  second: { type: Address, description: "Vault that receives the second deposit." },
} satisfies ParamsSpec;

@Protocol({
  name: "router",
  category: "dex",
  description: "Fixture Protocol composing two independently bound vaults.",
  contracts: {},
  protocols: { vaults: BoundVault },
})
class RouterProtocol {
  declare vaults: BoundVaultFactory;

  @Capability<RouterProtocol, typeof routeParams>({
    intent: "Deposit into two independently bound vaults",
    verb: "swap",
    params: routeParams,
    receipt: "routeReceipt",
    risk: ["fundOut"],
  })
  async route(params: InferParams<typeof routeParams>, ctx: { account: AddressValue }) {
    const first = this.vaults.create({ vault: params.first });
    const second = this.vaults.create({ vault: params.second });
    const read = await first.boundVault({});
    if (read.vault !== params.first) throw new Error("bound Query saw the wrong vault");
    return [
      await first.deposit({ amount: "1" }),
      await second.deposit({ amount: "2" }),
      transaction(ctx.account, FIXED, { data: "0xabcd" }),
    ];
  }

  @Receipt()
  routeReceipt(changes: readonly Change[]): MossReceipt<{ operation: "route" }> {
    return {
      kind: "receipt",
      outcome: { operation: "route" },
      text: "Routed two deposits",
      changes: [this.vaults.receipts.depositReceipt(changes)],
    };
  }
}

@Protocol({
  name: "plainvault",
  category: "token",
  description: "Fixture unbound vault Protocol.",
  contracts: { vault: { abi: VaultAbi, addr: FIXED } },
})
class PlainVault {
  declare vault: Handle<typeof VaultAbi>;

  @Capability<PlainVault, typeof depositParams>({
    intent: "Deposit {amount} native MON",
    verb: "supply",
    params: depositParams,
    receipt: "depositReceipt",
    risk: ["fundOut"],
  })
  async deposit({ amount }: InferParams<typeof depositParams>) {
    return [this.vault.deposit([], { value: parseUnits(amount, 18) })];
  }

  @Receipt()
  depositReceipt(changes: readonly Change[]): MossReceipt<null> {
    return {
      kind: "receipt",
      outcome: null,
      text: "deposited",
      changes: changes.map((change) => ({ kind: "change", change, data: null, text: "change" })),
    };
  }
}

function registry(): Registry {
  return new Registry(runtime).use(RouterProtocol, PlainVault);
}

function change(): Change {
  return { kind: "nativeTransfer", from: ACCOUNT, to: VAULT_A, value: "1" };
}

/** Reaches a name the declared surface does not carry, the way a wrong field type would. */
function forced(surface: unknown): Record<string, unknown> {
  return surface as Record<string, unknown>;
}

beforeEach(() => {
  used = [];
});

describe("Bound Protocol construction", () => {
  it("describes binding separately from method params, and omits it when unbound", () => {
    const [bound, plain] = registry().load([
      { protocol: "boundvault", method: "deposit" },
      { protocol: "plainvault", method: "deposit" },
    ]);

    expect(Object.keys(bound?.binding ?? {})).toEqual(["vault"]);
    expect(bound?.binding?.vault).toMatchObject({
      description: "Vault contract this instance deposits into.",
      type: { description: expect.stringContaining("20-byte EVM address") },
    });
    expect(Object.keys(bound?.params ?? {})).toEqual(["amount"]);
    expect(plain).not.toHaveProperty("binding");
    expect(Object.keys(plain?.params ?? {})).toEqual(["amount"]);
  });

  it("serializes canonical binding on a parameterized node and omits it on an unbound one", async () => {
    const registered = registry();

    const bound = await registered.action(
      "boundvault",
      "deposit",
      ACCOUNT,
      { amount: "1.5" },
      { vault: VAULT_A },
    );
    expect(bound).toEqual({
      kind: "capability",
      protocol: "boundvault",
      method: "deposit",
      binding: { vault: VAULT_A },
      params: { amount: "1.5" },
      children: [
        {
          kind: "transaction",
          transaction: {
            from: ACCOUNT,
            to: VAULT_A,
            data: "0xd0e30db0",
            value: "0x14d1120d7b160000",
          },
        },
      ],
    });

    const plain = await registered.action("plainvault", "deposit", ACCOUNT, { amount: "1.5" });
    expect(plain).not.toHaveProperty("binding");
    expect("binding" in plain).toBe(false);
  });

  it("creates independent uncached references whose Handles target their own binding", async () => {
    const registered = registry();
    const node = await registered.action("router", "route", ACCOUNT, {
      first: VAULT_A,
      second: VAULT_B,
    });
    if (node.kind !== "capability") throw new Error("expected Capability");

    // Two bindings of the same Protocol in one Capability never overwrite each other.
    expect(used).toEqual([VAULT_A, VAULT_B]);
    const [first, second, own] = node.children;
    expect(first).toMatchObject({
      kind: "capability",
      protocol: "boundvault",
      method: "deposit",
      binding: { vault: VAULT_A },
      params: { amount: "1" },
    });
    expect(second).toMatchObject({
      kind: "capability",
      protocol: "boundvault",
      method: "deposit",
      binding: { vault: VAULT_B },
      params: { amount: "2" },
    });
    expect(own).toMatchObject({ kind: "transaction" });
    if (first?.kind !== "capability" || second?.kind !== "capability") {
      throw new Error("expected nested Capabilities");
    }
    expect(first.children[0]).toMatchObject({ transaction: { to: VAULT_A } });
    expect(second.children[0]).toMatchObject({ transaction: { to: VAULT_B } });

    // Repeating one address still creates two instances rather than reusing one.
    const repeated = await registered.action("router", "route", ACCOUNT, {
      first: VAULT_A,
      second: VAULT_A,
    });
    if (repeated.kind !== "capability") throw new Error("expected Capability");
    expect(used).toEqual([VAULT_A, VAULT_B, VAULT_A, VAULT_A]);
    expect(repeated.children[0]).not.toBe(repeated.children[1]);
  });

  it("returns data from a bound Query and a stamped Receipt from the binding-free parsers", async () => {
    const registered = registry();
    const data = await registered.action(
      "boundvault",
      "boundVault",
      ACCOUNT,
      {},
      {
        vault: VAULT_B,
      },
    );
    expect(data).toEqual({
      kind: "query",
      protocol: "boundvault",
      method: "boundVault",
      data: { vault: VAULT_B },
    });

    // A parameterized root parses too, and its parser sees no binding: the
    // fixture throws if the Receipt instance carries the bound Handle.
    const bound = await registered.action(
      "boundvault",
      "deposit",
      ACCOUNT,
      { amount: "1" },
      { vault: VAULT_A },
    );
    if (bound.kind !== "capability") throw new Error("expected Capability");
    expect(registered.parseReceipt(bound, [change()])).toMatchObject({
      protocol: "boundvault",
      outcome: { operation: "supply" },
    });

    const node = await registered.action("router", "route", ACCOUNT, {
      first: VAULT_A,
      second: VAULT_B,
    });
    if (node.kind !== "capability") throw new Error("expected Capability");
    const changes = [change()];
    const receipt = registered.parseReceipt(node, changes);
    expect(receipt.protocol).toBe("router");
    expect(receipt.outcome).toEqual({ operation: "route" });
    const delegated = receipt.changes[0];
    if (delegated?.kind !== "receipt") throw new Error("expected a delegated Receipt");
    expect(delegated.protocol).toBe("boundvault");
    expect(delegated.outcome).toEqual({ operation: "supply" });
  });

  it("rejects a malformed binding before any Protocol code and without an RPC", async () => {
    const registered = registry();

    await expect(
      registered.action("boundvault", "deposit", ACCOUNT, { amount: "1" }, { vault: "nope" }),
    ).rejects.toThrow("invalid parameters");
    await expect(
      registered.action(
        "boundvault",
        "deposit",
        ACCOUNT,
        { amount: "1" },
        { vault: VAULT_A, extra: 1 },
      ),
    ).rejects.toThrow("invalid parameters");
    await expect(
      registered.action("router", "route", ACCOUNT, { first: VAULT_A, second: "nope" }),
    ).rejects.toThrow("invalid parameters");

    // No Capability body ran, so nothing could have reached the chain.
    expect(used).toEqual([]);
  });

  it("requires a binding exactly when the Protocol declares one", async () => {
    const registered = registry();

    await expect(
      registered.action("boundvault", "deposit", ACCOUNT, { amount: "1" }),
    ).rejects.toThrow('protocol "boundvault" is parameterized and requires a binding');
    await expect(
      registered.action("plainvault", "deposit", ACCOUNT, { amount: "1" }, { vault: VAULT_A }),
    ).rejects.toThrow('protocol "plainvault" is not parameterized and accepts no binding');
    expect(used).toEqual([]);
  });

  it("re-checks a wire-supplied node's binding against the Protocol it names", async () => {
    const registered = registry();
    const bound = (await registered.action(
      "boundvault",
      "deposit",
      ACCOUNT,
      { amount: "1" },
      { vault: VAULT_A },
    )) as CapabilityNode;
    const plain = (await registered.action("plainvault", "deposit", ACCOUNT, {
      amount: "1",
    })) as CapabilityNode;

    expect(() => registered.validateCapabilityTree(bound)).not.toThrow();
    expect(() => registered.validateCapabilityTree(plain)).not.toThrow();

    const { binding: _dropped, ...unbound } = bound;
    expect(() => registered.validateCapabilityTree(unbound)).toThrow(
      'capability "boundvault.deposit" is missing the binding that "boundvault" requires',
    );
    expect(() =>
      registered.validateCapabilityTree({ ...bound, binding: { vault: "nope" } }),
    ).toThrow("invalid parameters");
    expect(() =>
      registered.validateCapabilityTree({ ...plain, binding: { vault: VAULT_A } }),
    ).toThrow(
      'capability "plainvault.deposit" carries a binding, but "plainvault" is not parameterized',
    );
  });

  it("bounds a wire-supplied binding with the same budget as params", () => {
    const oversized: CapabilityNode = {
      kind: "capability",
      protocol: "boundvault",
      method: "deposit",
      binding: { vault: "0x".padEnd(300_000, "a") },
      params: { amount: "1" },
      children: [transaction(ACCOUNT, VAULT_A)],
    };
    expect(() => registry().validateCapabilityTree(oversized)).toThrow("PARAMETER_CHARACTERS");
  });

  it("keeps each surface to what it can honestly serve", async () => {
    const surfaces: Record<string, unknown> = {};

    @Protocol({
      name: "probe",
      category: "dex",
      description: "Fixture Protocol capturing the surfaces core injects.",
      contracts: {},
      protocols: { vaults: BoundVault, plain: PlainVault },
    })
    class ProbeProtocol {
      declare vaults: BoundVaultFactory;
      declare plain: ProtocolRef<PlainVault>;

      @Capability<ProbeProtocol, typeof noParams>({
        intent: "Capture every injected surface",
        verb: "swap",
        params: noParams,
        receipt: "probeReceipt",
        risk: ["fundOut"],
      })
      async probe(_: InferParams<typeof noParams>, ctx: { account: AddressValue }) {
        surfaces.factory = this.vaults;
        surfaces.bound = this.vaults.create({ vault: VAULT_A });
        surfaces.receipts = this.vaults.receipts;
        surfaces.plain = this.plain;
        return [transaction(ctx.account, FIXED, { data: "0x01" })];
      }

      @Receipt()
      probeReceipt(changes: readonly Change[]): MossReceipt<null> {
        surfaces.receiptDependency = this.vaults;
        return {
          kind: "receipt",
          outcome: null,
          text: "probed",
          changes: changes.map((c) => ({ kind: "change", change: c, data: null, text: "change" })),
        };
      }
    }

    const probed = new Registry(runtime).use(ProbeProtocol);
    const node = await probed.action("probe", "probe", ACCOUNT, {});
    if (node.kind !== "capability") throw new Error("expected Capability");
    probed.parseReceipt(node, [change()]);

    // A factory carries only create and receipts; its Protocol's own methods are not on it.
    expect(Object.keys(surfaces.factory as object)).toEqual(["create", "receipts"]);
    expect(() => forced(surfaces.factory).deposit).toThrow(
      'protocol "boundvault" is parameterized, so "deposit" is not on its factory',
    );
    expect(() => forced(surfaces.factory).depositReceipt).toThrow("reach a Capability or Query");

    // A Bound Protocol carries operations, never a parser.
    expect(Object.keys(surfaces.bound as object)).toEqual(["deposit", "boundVault"]);
    expect(() => forced(surfaces.bound).depositReceipt).toThrow(
      'Receipt parser "depositReceipt" is not on a Bound Protocol',
    );

    // The receipts surface carries parsers, never an operation.
    expect(Object.keys(surfaces.receipts as object)).toEqual(["depositReceipt"]);
    expect(() => forced(surfaces.receipts).deposit).toThrow(
      'exposes only pure Receipt parsers through "receipts"',
    );

    // An unbound dependency is not a factory, and says so.
    expect(() => forced(surfaces.plain).create).toThrow(
      'protocol "plainvault" is not parameterized, so it has no "create"',
    );

    // A Receipt parser gets the parsers and nothing that needs a Runtime.
    expect(Object.keys(surfaces.receiptDependency as object)).toEqual(["receipts"]);
    expect(() => forced(surfaces.receiptDependency).create).toThrow(
      'protocol "boundvault" cannot serve "create" to a Receipt parser',
    );
  });

  it("rejects binding metadata and derivations a Protocol cannot honour", () => {
    expect(() =>
      Protocol({
        name: "empty-binding",
        category: "token",
        description: "Fixture with an empty binding schema.",
        contracts: {},
        binding: { params: {}, contracts: () => ({}) },
      }),
    ).toThrow("binding must declare at least one parameter");
    expect(() =>
      Protocol({
        name: "no-derivation",
        category: "token",
        description: "Fixture with no binding derivation.",
        contracts: {},
        binding: { params: vaultBinding.params } as never,
      }),
    ).toThrow("binding must declare a contracts function");

    @Protocol({
      name: "undescribed-binding",
      category: "token",
      description: "Fixture whose binding Parameter type has no description.",
      contracts: {},
      binding: bindingSchema({
        params: { vault: { type: z.string(), description: "Vault address." } },
        contracts: ({ vault }) => ({ vault: { abi: VaultAbi, addr: vault as AddressValue } }),
      }),
    })
    class UndescribedBinding {
      @Query({ intent: "Inspect the fixture", params: noParams })
      async inspect() {
        return null;
      }
    }
    expect(() => new Registry(runtime).use(UndescribedBinding)).toThrow(
      'parameter "undescribed-binding.binding.vault" type description',
    );
  });

  it("rejects a binding schema that cannot settle synchronously", async () => {
    @Protocol({
      name: "async-binding",
      category: "token",
      description: "Fixture whose binding needs to await.",
      contracts: {},
      binding: bindingSchema({
        params: {
          vault: {
            type: z
              .string()
              .refine(async () => true)
              .describe("A vault address confirmed by an asynchronous check."),
            description: "Vault confirmed asynchronously.",
          },
        },
        contracts: ({ vault }) => ({ vault: { abi: VaultAbi, addr: vault as AddressValue } }),
      }),
    })
    class AsyncBinding {
      declare vault: Handle<typeof VaultAbi>;

      @Query({ intent: "Inspect the fixture", params: noParams })
      async inspect() {
        return null;
      }
    }

    await expect(
      new Registry(runtime)
        .use(AsyncBinding)
        .action("async-binding", "inspect", ACCOUNT, {}, { vault: VAULT_A }),
    ).rejects.toThrow("binding must validate synchronously");
  });

  it("rejects a derivation that produces no usable contracts", async () => {
    const cases = [
      { name: "derives-nothing", contracts: () => ({}), message: "derived no contracts" },
      {
        name: "derives-bad-address",
        contracts: () => ({ vault: { abi: VaultAbi, addr: "nope" as AddressValue } }),
        message: 'derived contract "vault" with an invalid address',
      },
      {
        name: "derives-no-abi",
        contracts: () => ({ vault: { addr: VAULT_A } as never }),
        message: 'derived contract "vault" without an ABI',
      },
      {
        name: "derives-async",
        contracts: () => Promise.resolve({}) as never,
        message: "must derive contracts synchronously",
      },
    ] as const;

    for (const { name, contracts, message } of cases) {
      @Protocol({
        name,
        category: "token",
        description: "Fixture with an unusable binding derivation.",
        contracts: {},
        binding: bindingSchema({
          params: { vault: { type: Address, description: "Vault address." } },
          contracts,
        }),
      })
      class Broken {
        @Query({ intent: "Inspect the fixture", params: noParams })
        async inspect() {
          return null;
        }
      }

      await expect(
        new Registry(runtime).use(Broken).action(name, "inspect", ACCOUNT, {}, { vault: VAULT_A }),
      ).rejects.toThrow(message);
    }
  });

  it("rejects a binding that shadows a fixed contract", async () => {
    @Protocol({
      name: "shadowed",
      category: "token",
      description: "Fixture whose binding derives a fixed contract's key.",
      contracts: { vault: { abi: VaultAbi, addr: FIXED } },
      binding: bindingSchema({
        params: { vault: { type: Address, description: "Vault address." } },
        contracts: ({ vault }) => ({ vault: { abi: VaultAbi, addr: vault } }),
      }),
    })
    class Shadowed {
      declare vault: Handle<typeof VaultAbi>;

      @Query({ intent: "Inspect the fixture", params: noParams })
      async inspect() {
        return null;
      }
    }

    await expect(
      new Registry(runtime)
        .use(Shadowed)
        .action("shadowed", "inspect", ACCOUNT, {}, { vault: VAULT_A }),
    ).rejects.toThrow('binding derived contract "vault", which is already a fixed contract');
  });
});
