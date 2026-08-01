import { parseAbi } from "viem";
import {
  Address,
  bindingSchema,
  Capability,
  type CapabilityNode,
  type Change,
  type Handle,
  type InferBinding,
  type InferParams,
  type ReceiptResult as MossReceipt,
  type MossRuntime,
  type ParamsSpec,
  PositiveDecimalString,
  Protocol,
  type ProtocolFactory,
  Query,
  Receipt,
  Registry,
  tokenMetadata,
} from "../src/index.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

@Protocol({
  name: "labeled-fixture",
  category: "token",
  description: "Compile-time label fixture.",
  contracts: {},
  labels: { Token: ADDRESS },
})
class LabeledFixture {}

@Protocol({
  name: "invalid-labeled-fixture",
  category: "token",
  description: "Compile-time invalid label fixture.",
  contracts: {},
  // @ts-expect-error Package label values must be EVM addresses.
  labels: { Token: "not-an-address" },
})
class InvalidLabeledFixture {}

const runtime = null as unknown as MossRuntime;
new Registry(runtime, { trustedTokens: [{ address: ADDRESS, label: "Token" }] });
new Registry(runtime, {
  // @ts-expect-error Trusted token addresses must be EVM addresses.
  trustedTokens: [{ address: "not-an-address", label: "Token" }],
});

const metadataResult = tokenMetadata(
  { kind: "metadata" as const, decimals: 18 as const },
  { address: ADDRESS, symbol: "TOKEN", name: "Token" },
);
const metadataKind: "metadata" = metadataResult.kind;
const metadataDecimals: 18 = metadataResult.decimals;
// @ts-expect-error token metadata requires a valid EVM address.
tokenMetadata({}, { address: "not-an-address", symbol: "TOKEN" });
// @ts-expect-error token metadata symbol must be a string.
tokenMetadata({}, { address: ADDRESS, symbol: 18 });
// @ts-expect-error tokenMetadata attaches observations only to object Query results.
tokenMetadata("metadata", { address: ADDRESS });

// --- Binding schema contract -------------------------------------------------

const VaultAbi = parseAbi(["function deposit() payable"]);

const vaultBinding = bindingSchema({
  params: { vault: { type: Address, description: "Vault contract this instance uses." } },
  contracts: ({ vault }) => ({ vault: { abi: VaultAbi, addr: vault } }),
});

// The binding type is derived from the runtime schema, so the two cannot drift.
const validBinding: InferBinding<typeof vaultBinding> = { vault: ADDRESS };
// @ts-expect-error a binding value follows its declared Parameter type.
const invalidBinding: InferBinding<typeof vaultBinding> = { vault: 42 };
// @ts-expect-error a binding carries only its declared fields.
const widenedBinding: InferBinding<typeof vaultBinding> = { vault: ADDRESS, amount: "1" };

bindingSchema({
  params: { vault: { type: Address, description: "Vault contract this instance uses." } },
  // @ts-expect-error the derivation receives the parsed binding, which declares no "token".
  contracts: ({ token }) => ({ vault: { abi: VaultAbi, addr: token } }),
});
bindingSchema({
  params: { vault: { type: Address, description: "Vault contract this instance uses." } },
  // @ts-expect-error a derived contract config needs both an ABI and an address.
  contracts: ({ vault }) => ({ vault: { addr: vault } }),
});

// --- Decorator contract ------------------------------------------------------

const depositParams = {
  amount: { type: PositiveDecimalString, description: "Native MON to deposit." },
} satisfies ParamsSpec;

@Protocol({
  name: "bound-fixture",
  category: "token",
  description: "Compile-time binding fixture.",
  contracts: {},
  binding: vaultBinding,
})
class BoundFixture {
  declare vault: Handle<typeof VaultAbi>;

  @Capability<BoundFixture, typeof depositParams>({
    intent: "Deposit {amount} into the bound vault",
    verb: "supply",
    params: depositParams,
    receipt: "depositReceipt",
    risk: ["fundOut"],
  })
  async deposit({ amount }: InferParams<typeof depositParams>) {
    // The bound Handle is ABI-typed, so only the vault's own functions resolve.
    void this.vault.deposit([], { value: BigInt(amount) });
    // @ts-expect-error the bound Handle exposes only its ABI's functions.
    void this.vault.withdraw([]);
    return [this.vault.deposit([])];
  }

  @Query({ intent: "Read which vault this instance is bound to", params: {} })
  async boundVault() {
    return { vault: this.vault.address };
  }

  @Receipt()
  depositReceipt(changes: readonly Change[]): MossReceipt<{ operation: "supply" }> {
    return {
      kind: "receipt",
      outcome: { operation: "supply" },
      text: "deposited",
      changes: changes.map((change) => ({
        kind: "change",
        change,
        data: { operation: "supply" },
        text: "deposited",
      })),
    };
  }
}

@Protocol({
  name: "invalid-bound-fixture",
  category: "token",
  description: "Compile-time invalid binding fixture.",
  contracts: {},
  // @ts-expect-error a binding schema declares params and a contracts derivation.
  binding: { params: { vault: Address } },
})
class InvalidBoundFixture {}

// --- Factory contract --------------------------------------------------------

/** The alias a parameterized package exports for its consumers. */
type BoundFixtureFactory = ProtocolFactory<BoundFixture, typeof vaultBinding, "depositReceipt">;

// A factory may publish only its own Protocol's Receipt parsers.
// @ts-expect-error "deposit" is a Capability, not a Receipt parser.
type InvalidReceiptsFactory = ProtocolFactory<BoundFixture, typeof vaultBinding, "deposit">;
// @ts-expect-error "boundVault" is a Query, not a Receipt parser.
type InvalidQueryFactory = ProtocolFactory<BoundFixture, typeof vaultBinding, "boundVault">;

declare const factory: BoundFixtureFactory;

const bound = factory.create({ vault: ADDRESS });
// @ts-expect-error a ProtocolFactory is a non-callable object.
factory({ vault: ADDRESS });
// @ts-expect-error create validates against the declared binding type.
factory.create({ vault: 42 });
// @ts-expect-error create takes the binding only, never method params.
factory.create({ vault: ADDRESS, amount: "1" });
// @ts-expect-error create needs a binding.
factory.create();

// --- Method contract ---------------------------------------------------------

const depositNode: Promise<CapabilityNode> = bound.deposit({ amount: "1" });
const boundVaultData: Promise<{ vault: `0x${string}` }> = bound.boundVault({});
// @ts-expect-error identity is not repeated in a bound Protocol's method params.
bound.deposit({ vault: ADDRESS, amount: "1" });
// @ts-expect-error method params keep their declared Parameter types.
bound.deposit({ amount: 1 });
// @ts-expect-error a Receipt parser is not on a Bound Protocol.
bound.depositReceipt([]);

// --- Receipt-reference contract ----------------------------------------------

const parsed: { protocol: string; outcome: { operation: "supply" } } =
  factory.receipts.depositReceipt([]);
// @ts-expect-error a Capability is not on the receipts surface.
factory.receipts.deposit({ amount: "1" });
// @ts-expect-error a Query is not on the receipts surface.
factory.receipts.boundVault({});
// @ts-expect-error a parser reads Changes, never a binding.
factory.receipts.depositReceipt({ vault: ADDRESS });
// @ts-expect-error the receipts surface publishes only the declared parser set.
factory.receipts.unpublishedReceipt([]);

// --- Dependency declaration contract -----------------------------------------

@Protocol({
  name: "composer-fixture",
  category: "dex",
  description: "Compile-time fixture declaring a parameterized dependency.",
  contracts: {},
  protocols: { vaults: BoundFixture },
})
class ComposerFixture {
  declare vaults: BoundFixtureFactory;

  @Query({ intent: "Read a bound vault", params: {} })
  async inspect() {
    return this.vaults.create({ vault: ADDRESS }).boundVault({});
  }
}

// @ts-expect-error a declared dependency is injected as a Protocol reference or a factory.
@Protocol({
  name: "mistyped-composer-fixture",
  category: "dex",
  description: "Compile-time fixture whose dependency field is not injectable.",
  contracts: {},
  protocols: { vaults: BoundFixture },
})
class MistypedComposerFixture {
  declare vaults: string;

  @Query({ intent: "Read the fixture", params: {} })
  async inspect() {
    return this.vaults;
  }
}

void LabeledFixture;
void InvalidLabeledFixture;
void metadataKind;
void metadataDecimals;
void validBinding;
void invalidBinding;
void widenedBinding;
void InvalidBoundFixture;
void ComposerFixture;
void MistypedComposerFixture;
void depositNode;
void boundVaultData;
void parsed;
declare const invalidReceiptsFactory: InvalidReceiptsFactory;
declare const invalidQueryFactory: InvalidQueryFactory;
void invalidReceiptsFactory;
void invalidQueryFactory;
