declare module 'ssh-config' {
  interface ParsedConfig extends Array<unknown> {
    compute(host: string, options?: { matchExec?: boolean }): Record<string, unknown>;
  }
  const SSHConfig: { parse(text: string): ParsedConfig };
  export default SSHConfig;
}
