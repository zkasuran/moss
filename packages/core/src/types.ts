import type { Address, Hex } from "viem";

export type { Address, Hex };

export const VERBS = [
  "swap",
  "wrap",
  "unwrap",
  "supply",
  "withdraw",
  "borrow",
  "repay",
  "stake",
  "unstake",
  "claim",
  "mint",
  "transfer",
  "approve",
] as const;
export type Verb = (typeof VERBS)[number];

export const CATEGORIES = ["dex", "lending", "staking", "rewards", "token", "nft"] as const;
export type Category = (typeof CATEGORIES)[number];

export const RISK_LABELS = ["fundOut", "approval", "priceImpact"] as const;
export type RiskLabel = (typeof RISK_LABELS)[number];

export const NATIVE = "native" as const;
export type TokenRef = Address | typeof NATIVE;

export type JsonSafeValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafeValue[]
  | { readonly [key: string]: JsonSafeValue };

export interface TrustedToken {
  address: Address;
  label: string;
}

export interface RegistryOptions {
  trustedTokens?: readonly TrustedToken[];
}

export interface PackageLabel {
  packageName: string;
  name: string;
}

export interface LabelScope {
  packageName: string;
  own: ReadonlyMap<string, string>;
  dependencies: ReadonlyMap<string, PackageLabel | null>;
}

export interface UnsignedTx {
  from: Address;
  to: Address;
  data: Hex;
  value: Hex;
}

export interface TransactionNode {
  kind: "transaction";
  transaction: UnsignedTx;
}

export interface CapabilityNode {
  kind: "capability";
  protocol: string;
  method: string;
  /**
   * Canonical binding of the parameterized Protocol that produced this node.
   * Absent for an unbound Protocol, which has no identity to carry. Receipt
   * parsing never receives or trusts it: it is serialized so an SDK consumer
   * can see which instance acted, not so a parser can read evidence from it.
   */
  binding?: JsonSafeValue;
  params: JsonSafeValue;
  children: readonly (CapabilityNode | TransactionNode)[];
}

export type CapabilityResult =
  | CapabilityNode
  | TransactionNode
  | readonly (CapabilityNode | TransactionNode)[];

export type ProtocolRef<T> = {
  [K in keyof T as T[K] extends (...args: infer _Args) => infer _Result ? K : never]: T[K] extends (
    params: infer Params,
    ...args: infer _Rest
  ) => infer Result
    ? Awaited<Result> extends CapabilityResult
      ? (params: Params) => Promise<CapabilityNode>
      : Result extends ReceiptResult<infer Outcome>
        ? (params: Params, ...args: _Rest) => Receipt<Outcome>
        : (params: Params) => Promise<Awaited<Result>>
    : never;
};

/**
 * One Bound Protocol's operation surface, returned by a factory's `create`.
 * Capabilities nest into the caller's tree and Queries return ordinary data,
 * exactly as for an unbound dependency.
 *
 * Receipt parsers are deliberately absent. A parser is pure and binding-free,
 * so it lives on the factory's own `receipts` surface instead: reaching one
 * through a bound instance would suggest a parser can read the binding, and it
 * cannot.
 */
export type BoundProtocolRef<T> = {
  [K in keyof T as T[K] extends (...args: infer _Args) => infer Result
    ? Result extends ReceiptResult<JsonSafeValue>
      ? never
      : K
    : never]: T[K] extends (params: infer Params, ...args: infer _Rest) => infer Result
    ? Awaited<Result> extends CapabilityResult
      ? (params: Params) => Promise<CapabilityNode>
      : (params: Params) => Promise<Awaited<Result>>
    : never;
};

/**
 * Registry-resolved pure Receipt parsers of one Protocol, carrying no Runtime,
 * account, Handles or binding. A caller parser delegates a Change interval
 * through this surface and embeds the returned Receipt unchanged.
 */
export type ReceiptRef<T> = {
  [K in keyof T as T[K] extends (changes: readonly Change[]) => ReceiptResult<JsonSafeValue>
    ? K
    : never]: T[K] extends (changes: readonly Change[]) => ReceiptResult<infer Outcome>
    ? (changes: readonly Change[]) => Receipt<Outcome>
    : never;
};

export type Change =
  | {
      kind: "event";
      address: Address;
      topics: readonly Hex[];
      data: Hex;
    }
  | {
      kind: "nativeTransfer";
      from: Address;
      to: Address;
      value: string;
    };

export interface ReceiptChange {
  kind: "change";
  change: Change;
  data: JsonSafeValue;
  text: string;
}

export interface ReceiptResult<TOutcome extends JsonSafeValue = JsonSafeValue> {
  kind: "receipt";
  outcome: TOutcome;
  text: string;
  changes: readonly (ReceiptChange | ReceiptResult<JsonSafeValue>)[];
}

export interface Receipt<TOutcome extends JsonSafeValue = JsonSafeValue>
  extends ReceiptResult<TOutcome> {
  protocol: string;
  changes: readonly (ReceiptChange | Receipt<JsonSafeValue>)[];
}
