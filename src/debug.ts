/** Scopes enabled via DEBUG. '1'/'true'/'*' turns on everything; otherwise a
 *  comma-separated allowlist (e.g. DEBUG=ask,session). Empty = silent. */
function enabledScopes(): Set<string> {
  return new Set(
    (process.env.DEBUG ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const debugEnabled = (scope: string): boolean => {
  const enabled = enabledScopes();
  return enabled.has('1') || enabled.has('true') || enabled.has('*') || enabled.has(scope.toLowerCase());
};

/** Verbose trace line, gated on DEBUG. */
export const debug = (scope: string, msg: string, ...args: unknown[]): void => {
  if (!debugEnabled(scope)) return;
  console.log(`[debug:${scope}] ${msg}`, ...args);
};
