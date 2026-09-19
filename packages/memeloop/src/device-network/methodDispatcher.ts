/** Typed method-table dispatcher for RPC handlers with a single unknown-method path. */

export type RpcMethodHandler<Input, Output> = (input: Input) => Output | Promise<Output>;

export function createMethodDispatcher<
  Method extends string,
  Input,
  Output,
>(
  handlers: Partial<Record<Method, RpcMethodHandler<Input, Output>>>,
  onUnknown: (method: string) => Error = method => new Error(`Unknown RPC method: ${method}`),
): (method: string, input: Input) => Promise<Output> {
  return async (method, input) => {
    const handler = handlers[method as Method];
    if (!handler) throw onUnknown(method);
    return handler(input);
  };
}
