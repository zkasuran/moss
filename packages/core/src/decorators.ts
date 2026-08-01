import type { Abi } from "viem";
import { createHandle } from "./handle.js";
import type { MossRuntime } from "./runtime.js";
import type { InferParams, ParamsSpec } from "./semantics.js";
import type {
  Address,
  BoundProtocolRef,
  CapabilityResult,
  Category,
  Change,
  JsonSafeValue,
  Receipt as ParsedReceipt,
  ProtocolRef,
  ReceiptRef,
  ReceiptResult,
  RiskLabel,
  Verb,
} from "./types.js";

export interface ContractConfig {
  abi: Abi;
  addr: Address;
}

/**
 * How a parameterized Protocol turns one validated binding into its dynamic
 * Handles. `params` declares the identity fields with the same
 * `{ type, description }` contract as a Capability, and `contracts` derives the
 * instance's contract configs from the parsed values.
 *
 * Both halves are synchronous and externally pure: binding decides which
 * contract an instance points at, so it must be settled before anything is
 * built and without reading the chain. Core parses `params` with Zod's
 * synchronous parse, which rejects an async refinement outright, and calls
 * `contracts` exactly once per `create`.
 */
export interface BindingSchema<Params extends ParamsSpec = ParamsSpec> {
  params: Params;
  // Method syntax on purpose: Registry holds every schema as a
  // `BindingSchema<ParamsSpec>`, which a strictly contravariant property
  // signature would refuse.
  contracts(binding: InferParams<Params>): Record<string, ContractConfig>;
}

/** The validated binding value a schema accepts, derived from that schema. */
export type InferBinding<Schema extends BindingSchema> = InferParams<Schema["params"]>;

/**
 * Declares one Protocol's binding schema. This is an identity helper: it exists
 * so `contracts` sees the parameter types inferred from `params` at the
 * declaration site, and so the package can name the schema and build its
 * factory alias from it.
 */
export function bindingSchema<const Params extends ParamsSpec>(
  schema: BindingSchema<Params>,
): BindingSchema<Params> {
  return schema;
}

declare const PROTOCOL_FACTORY: unique symbol;

/**
 * The surface Registry injects for a declared parameterized dependency, and the
 * alias a parameterized package exports for its consumers. Non-callable by
 * construction: `create` validates one binding and returns an independent
 * Registry-managed reference, while `receipts` carries only pure parsers.
 *
 * `Receipts` is written out by the package that owns the Protocol rather than
 * swept from its shape. TypeScript cannot observe a decorator, so a wholesale
 * structural map would also admit an undecorated helper that happens to return
 * a `ReceiptResult`. Naming the parsers makes the published set a declaration,
 * and Registry still refuses at the call site anything that is not an
 * `@Receipt` method.
 */
export interface ProtocolFactory<
  T,
  Schema extends BindingSchema,
  Receipts extends ReceiptNames<T>,
> {
  readonly [PROTOCOL_FACTORY]: T;
  create(binding: InferBinding<Schema>): BoundProtocolRef<T>;
  readonly receipts: ReceiptRef<Pick<T, Receipts & keyof T>>;
}

/** Any factory over `T`, whatever binding schema or parser set it publishes. */
export interface AnyProtocolFactory<T> {
  readonly [PROTOCOL_FACTORY]: T;
}

export type ProtocolCtor = new () => object;
export type ProtocolDependencies = Record<string, ProtocolCtor>;

/**
 * What Registry may inject for one declared dependency: a reference when that
 * Protocol is unbound, or a factory when it is parameterized. Core cannot tell
 * the two apart from the class type alone, because the binding lives in
 * decorator metadata that TypeScript cannot see, so the declaring Protocol
 * names the parameterized package's exported factory alias (ADR 0010).
 */
type InjectedProtocols<Dependencies extends ProtocolDependencies> = {
  [K in keyof Dependencies]:
    | ProtocolRef<InstanceType<Dependencies[K]>>
    | AnyProtocolFactory<InstanceType<Dependencies[K]>>;
};

export interface ProtocolConfig<Dependencies extends ProtocolDependencies = Record<never, never>> {
  name: string;
  category: Category;
  description: string;
  /** Fixed contracts, identical for every instance of this Protocol. */
  contracts: Record<string, ContractConfig>;
  /** Present only on a parameterized Protocol, whose Handles depend on binding. */
  binding?: BindingSchema;
  labels?: Record<string, Address>;
  protocols?: Dependencies;
}

export type ReceiptNames<This> = {
  [K in keyof This]: This[K] extends (changes: readonly Change[]) => infer Result
    ? Result extends ParsedReceipt<JsonSafeValue>
      ? never
      : Result extends ReceiptResult<JsonSafeValue>
        ? K
        : never
    : never;
}[keyof This] &
  string;

export interface CapabilitySpec<This, Params extends ParamsSpec = ParamsSpec> {
  intent: string;
  verb: Verb;
  params: Params;
  receipt: ReceiptNames<This>;
  risk: RiskLabel[];
  tags?: string[];
}

export interface QuerySpec<Params extends ParamsSpec = ParamsSpec> {
  intent: string;
  params: Params;
  tags?: string[];
}

export type MethodMeta =
  | { kind: "capability"; spec: CapabilitySpec<object> }
  | { kind: "query"; spec: QuerySpec };

export const PROTOCOL_META = Symbol.for("moss.protocol");
export const PROTOCOL_TARGET = Symbol.for("moss.protocol.target");
export const METHOD_META = Symbol.for("moss.method");
export const RECEIPT_META = Symbol.for("moss.receipt");

export function Protocol<Dependencies extends ProtocolDependencies = Record<never, never>>(
  config: ProtocolConfig<Dependencies>,
) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(config.name)) {
    throw new Error(`protocol name "${config.name}" must be a lowercase slug`);
  }
  if (config.binding !== undefined) {
    const { params, contracts } = config.binding;
    if (!params || typeof params !== "object" || Object.keys(params).length === 0) {
      throw new Error(`protocol "${config.name}" binding must declare at least one parameter`);
    }
    if (typeof contracts !== "function") {
      throw new Error(`protocol "${config.name}" binding must declare a contracts function`);
    }
  }
  return <T extends new () => object & InjectedProtocols<Dependencies>>(
    target: T,
    context: ClassDecoratorContext<T>,
  ): T => {
    if (context.kind !== "class") throw new Error("@Protocol decorates classes");
    const Base = target as new () => object;
    const injected = class extends Base {
      constructor(...args: unknown[]) {
        super();
        const [runtime, account, dependencies = {}, boundContracts] = args as [
          MossRuntime,
          Address,
          Record<string, object>?,
          Record<string, ContractConfig>?,
        ];
        if (!runtime?.client || !account) {
          throw new Error(`protocol "${config.name}" must be constructed by Registry`);
        }
        if (!config.binding !== !boundContracts) {
          throw new Error(
            `protocol "${config.name}" must be constructed with ${config.binding ? "its" : "no"} binding Handles`,
          );
        }
        // Fixed Handles first, so a binding that derives a key already taken by
        // a fixed contract is reported instead of silently shadowing it.
        for (const [key, contract] of Object.entries(config.contracts)) {
          Object.defineProperty(this, key, {
            value: createHandle(contract.abi, contract.addr, runtime.client, account),
            writable: false,
          });
        }
        for (const [key, contract] of Object.entries(boundContracts ?? {})) {
          if (Object.hasOwn(this, key)) {
            throw new Error(
              `protocol "${config.name}" binding derived contract "${key}", which is already a fixed contract`,
            );
          }
          Object.defineProperty(this, key, {
            value: createHandle(contract.abi, contract.addr, runtime.client, account),
            writable: false,
          });
        }
        Object.defineProperty(this, "runtime", { value: runtime, writable: false });
        for (const key of Object.keys(config.protocols ?? {})) {
          const dependency = dependencies[key];
          if (!dependency) {
            throw new Error(`protocol "${config.name}" dependency "${key}" was not injected`);
          }
          Object.defineProperty(this, key, { value: dependency, writable: false });
        }
      }
    };
    Object.defineProperty(injected, "name", { value: target.name });
    Object.defineProperty(injected, PROTOCOL_META, { value: config });
    Object.defineProperty(injected, PROTOCOL_TARGET, { value: target });
    return injected as unknown as T;
  };
}

function recordMethod(
  method: (...args: never[]) => unknown,
  context: ClassMethodDecoratorContext,
  kind: MethodMeta["kind"],
  spec: CapabilitySpec<object> | QuerySpec,
): void {
  if (context.kind !== "method" || context.static) {
    throw new Error(`@${kind === "capability" ? "Capability" : "Query"} decorates methods`);
  }
  Object.defineProperty(method, METHOD_META, { value: { kind, spec } as MethodMeta });
}

type CapabilityMethod<Params extends ParamsSpec> = (
  params: InferParams<Params>,
  context: { account: Address },
) => CapabilityResult | Promise<CapabilityResult>;

type QueryMethod<Params extends ParamsSpec> = (
  params: InferParams<Params>,
  context: { account: Address },
) => unknown;

export function Capability<This, Params extends ParamsSpec>(spec: CapabilitySpec<This, Params>) {
  return <Method extends CapabilityMethod<Params>>(
    method: Method,
    context: ClassMethodDecoratorContext<This, Method>,
  ): void => {
    recordMethod(
      method,
      context as ClassMethodDecoratorContext,
      "capability",
      spec as unknown as CapabilitySpec<object>,
    );
  };
}

export function Query<Params extends ParamsSpec>(spec: QuerySpec<Params>) {
  return <This, Method extends QueryMethod<Params>>(
    method: Method,
    context: ClassMethodDecoratorContext<This, Method>,
  ): void => {
    recordMethod(method, context as ClassMethodDecoratorContext, "query", spec);
  };
}

export function Receipt() {
  return <This, Method extends (changes: readonly Change[]) => ReceiptResult<JsonSafeValue>>(
    method: Method & (ReturnType<Method> extends ParsedReceipt<JsonSafeValue> ? never : unknown),
    context: ClassMethodDecoratorContext<This, Method>,
  ): void => {
    if (context.kind !== "method" || context.static) {
      throw new Error("@Receipt decorates instance methods");
    }
    Object.defineProperty(method, RECEIPT_META, { value: true });
  };
}

/** Core-identified Receipt returned by Registry and injected Receipt dependencies. */
export type Receipt<TOutcome extends JsonSafeValue = JsonSafeValue> = ParsedReceipt<TOutcome>;
