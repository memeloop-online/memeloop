/**
 * Shared typed request/response binder for embedded RPC contracts.
 *
 * A contract descriptor owns the untrusted decode and correlation rules while
 * this helper owns the invariant call sequence: abort check, request
 * validation, transport call, response parsing, and correlation.  Keeping
 * that sequence in one place prevents the small clients from drifting apart
 * while each protocol retains its own wire validation.
 */

export type RpcContractEntry = {
  request: unknown;
  response: unknown;
};

type RpcContractShape<Contract extends object> = {
  [K in keyof Contract]: RpcContractEntry;
};

type RequestOf<Contract extends RpcContractShape<Contract>, M extends keyof Contract> = Contract[M]['request'];

type ResponseOf<Contract extends RpcContractShape<Contract>, M extends keyof Contract> = Contract[M]['response'];

export interface RpcContractDescriptor<Contract extends RpcContractShape<Contract>> {
  validateRequest<M extends keyof Contract & string>(
    method: M,
    value: RequestOf<Contract, M>,
  ): void | Promise<void>;
  parseResponse<M extends keyof Contract & string>(
    method: M,
    value: unknown,
  ): ResponseOf<Contract, M>;
  assertCorrelation<M extends keyof Contract & string>(
    method: M,
    request: RequestOf<Contract, M>,
    response: ResponseOf<Contract, M>,
  ): void;
}

export type RpcContractCall<
  Contract extends RpcContractShape<Contract>,
  CallOptions,
> = <M extends keyof Contract & string>(
  method: M,
  request: RequestOf<Contract, M>,
  options?: CallOptions,
) => Promise<unknown>;

export type RpcContractClient<
  Contract extends RpcContractShape<Contract>,
  CallOptions,
> = {
  request<M extends keyof Contract & string>(
    method: M,
    request: RequestOf<Contract, M>,
    options?: CallOptions,
  ): Promise<ResponseOf<Contract, M>>;
  bind<M extends keyof Contract & string>(
    method: M,
  ): (
    request: RequestOf<Contract, M>,
    options?: CallOptions,
  ) => Promise<ResponseOf<Contract, M>>;
};

export type CheckedRpcContractCall<
  Contract extends RpcContractShape<Contract>,
  CallOptions,
> = <M extends keyof Contract & string>(
  method: M,
  request: RequestOf<Contract, M>,
  options?: CallOptions,
) => Promise<ResponseOf<Contract, M>>;

/** Run one typed contract call with the shared trust-boundary sequence. */
export async function callRpcContract<
  Contract extends RpcContractShape<Contract>,
  M extends keyof Contract & string,
  CallOptions,
>(
  descriptor: RpcContractDescriptor<Contract>,
  call: RpcContractCall<Contract, CallOptions>,
  method: M,
  request: RequestOf<Contract, M>,
  options: CallOptions | undefined,
  throwIfAborted?: (options: CallOptions | undefined) => void,
): Promise<ResponseOf<Contract, M>> {
  throwIfAborted?.(options);
  await descriptor.validateRequest(method, request);
  throwIfAborted?.(options);
  const raw = await call(method, request, options);
  throwIfAborted?.(options);
  const response = descriptor.parseResponse(method, raw);
  descriptor.assertCorrelation(method, request, response);
  return response;
}

/** Create a client exposing both generic request and method-specific binders. */
export function createRpcContractClient<
  Contract extends RpcContractShape<Contract>,
  CallOptions,
>(options: {
  descriptor: RpcContractDescriptor<Contract>;
  call: RpcContractCall<Contract, CallOptions>;
  throwIfAborted?: (options: CallOptions | undefined) => void;
}): RpcContractClient<Contract, CallOptions> {
  const request = <M extends keyof Contract & string>(
    method: M,
    parameters: RequestOf<Contract, M>,
    callOptions?: CallOptions,
  ): Promise<ResponseOf<Contract, M>> =>
    callRpcContract(
      options.descriptor,
      options.call,
      method,
      parameters,
      callOptions,
      options.throwIfAborted,
    );

  return {
    request,
    bind<M extends keyof Contract & string>(method: M) {
      return (
        parameters: RequestOf<Contract, M>,
        callOptions?: CallOptions,
      ): Promise<ResponseOf<Contract, M>> => request(method, parameters, callOptions);
    },
  };
}

/** Bind one method from an already-created contract runner. */
export function bindRpcContractMethod<
  Contract extends RpcContractShape<Contract>,
  CallOptions,
  M extends keyof Contract & string,
>(
  request: RpcContractClient<Contract, CallOptions>['request'],
  method: M,
): (
  parameters: RequestOf<Contract, M>,
  options?: CallOptions,
) => Promise<ResponseOf<Contract, M>> {
  return (
    parameters: RequestOf<Contract, M>,
    options?: CallOptions,
  ): Promise<ResponseOf<Contract, M>> => request(method, parameters, options);
}

/** Bind one method from a generic call that already performs validation. */
export function bindRpcMethod<
  Contract extends RpcContractShape<Contract>,
  CallOptions,
  M extends keyof Contract & string,
>(
  call: CheckedRpcContractCall<Contract, CallOptions>,
  method: M,
): (
  request: RequestOf<Contract, M>,
  options?: CallOptions,
) => Promise<ResponseOf<Contract, M>> {
  return (
    request: RequestOf<Contract, M>,
    options?: CallOptions,
  ): Promise<ResponseOf<Contract, M>> => call(method, request, options);
}

/**
 * Small non-map variant for adapters whose method-specific overloads are
 * already represented by the supplied generic call signature.
 */
