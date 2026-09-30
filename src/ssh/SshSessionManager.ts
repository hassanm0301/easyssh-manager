import type { RemoteConnection } from '../connections/types';
import type { SshClientFactory } from './SshClientFactory';
import type {
  ConnectionPurpose,
  ConnectionResolver,
  CredentialResolver,
  SshConnectionHandle,
  SshSessionManager as SshSessionManagerPort,
} from './ports';

export class DefaultSshSessionManager implements SshSessionManagerPort {
  private readonly handles = new Map<string, SshConnectionHandle>();

  constructor(
    private readonly connections: ConnectionResolver,
    private readonly credentials: CredentialResolver,
    private readonly clients: Pick<SshClientFactory, 'connect'>,
    private readonly shutdownTimeoutMs = 3_000,
  ) {}

  get activeConnectionCount(): number {
    return this.handles.size;
  }

  async connect(connectionId: string, purpose: ConnectionPurpose): Promise<SshConnectionHandle> {
    return this.connectCandidate(await this.connections.resolve(connectionId), purpose);
  }

  async connectCandidate(
    connection: RemoteConnection,
    purpose: ConnectionPurpose,
  ): Promise<SshConnectionHandle> {
    const lease = await this.credentials.acquire(
      connection,
      { kind: purpose.kind === 'terminal' ? 'terminal' : 'sftp', scopeId: purpose.scopeId },
      purpose.transientCredentials,
    );
    const handle = await this.clients.connect(connection, lease, purpose.cancellation);
    this.handles.set(handle.id, handle);
    const subscription = handle.onDidClose(() => {
      subscription.dispose();
      this.handles.delete(handle.id);
    });
    return handle;
  }

  async disposeConnection(handleId: string): Promise<void> {
    const handle = this.handles.get(handleId);
    if (!handle) return;
    this.handles.delete(handleId);
    await handle[Symbol.asyncDispose]();
  }

  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()].reverse();
    this.handles.clear();
    const cleanup = Promise.allSettled(handles.map((handle) => handle[Symbol.asyncDispose]()));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.shutdownTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disposeAll();
  }

  async dispose(): Promise<void> {
    await this.disposeAll();
  }
}
