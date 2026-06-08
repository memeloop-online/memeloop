export function formatToolResultMessage(
  toolName: string,
  parameters: Record<string, unknown>,
  body: string,
  isError: boolean,
): string {
  return `<functions_result>
Tool: ${toolName}
Parameters: ${JSON.stringify(parameters)}
${isError ? "Error" : "Result"}: ${body}
</functions_result>`;
}
