declare module 'ssh-config' {
  interface ParsedConfig extends Array<unknown> {
    compute(host: string): Record<string, unknown>;
  }
  const SSHConfig: { parse(text: string): ParsedConfig };
  export default SSHConfig;
}
