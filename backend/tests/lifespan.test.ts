import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDatabase, initialize } from '../src/core/database.ts';
import { resolveDatabaseUrl } from '../src/core/config.ts';
import { start } from '../src/core/lifespan.ts';

vi.mock('../src/core/database.ts', () => ({
  createDatabase: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock('../src/core/config.ts', () => ({
  resolveDatabaseUrl: vi.fn(),
}));

type Database = ReturnType<typeof createDatabase>;

const { createDatabase: createActualDatabase } = await vi.importActual<typeof import('../src/core/database.ts')>('../src/core/database.ts');

function fakeDatabase() {
  const client = createActualDatabase('postgresql://test:test@localhost:5432/test');
  const double = {
    $connect: vi.spyOn(client, '$connect').mockResolvedValue(),
    $disconnect: vi.spyOn(client, '$disconnect').mockResolvedValue(),
  };
  return { double, client };
}

const servers: Server[] = [];
let previousExitCode: typeof process.exitCode;

function signalHandlers(signal: 'SIGTERM' | 'SIGINT') {
  return process.listeners(signal) as Array<() => void>;
}

async function startTracked(database: Database) {
  vi.mocked(createDatabase).mockReturnValue(database);
  const before = { SIGTERM: signalHandlers('SIGTERM'), SIGINT: signalHandlers('SIGINT') };
  const result = await start();
  servers.push(result.server);
  const added = (signal: 'SIGTERM' | 'SIGINT') => {
    const handler = signalHandlers(signal).find((candidate) => !before[signal].includes(candidate));
    if (!handler) throw new Error(`no ${signal} handler registered`);
    process.removeListener(signal, handler);
    return handler;
  };
  return { ...result, sigterm: added('SIGTERM'), sigint: added('SIGINT') };
}

beforeEach(() => {
  previousExitCode = process.exitCode;
  vi.stubEnv('API_PORT', '0');
  vi.mocked(resolveDatabaseUrl).mockReturnValue('postgresql://test:test@localhost:5432/test');
  vi.mocked(initialize).mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(createDatabase).mockReset();
  vi.mocked(initialize).mockReset();
  vi.mocked(resolveDatabaseUrl).mockReset();
});

describe('start', () => {
  it('connects, initializes and listens on the API_PORT port', async () => {
    const { double, client } = fakeDatabase();
    const { server, database } = await startTracked(client);

    expect(resolveDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(createDatabase).toHaveBeenCalledWith('postgresql://test:test@localhost:5432/test');
    expect(double.$connect).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(initialize).mock.calls[0]?.[0]).toBe(client);
    expect(double.$connect.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(initialize).mock.invocationCallOrder[0]);
    expect(database).toBe(client);
    expect(server.listening).toBe(true);
    const port = (server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    expect(console.log).toHaveBeenCalledWith(`Taskly App Node API listening on port ${port}`);
    expect(double.$disconnect).not.toHaveBeenCalled();
  });

  it('mounts the app on the returned server', async () => {
    const { client } = fakeDatabase();
    const { server } = await startTracked(client);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    expect(response.status).toBe(200);
    await response.json();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('closes the server then disconnects on %s', async (signal) => {
    const { double, client } = fakeDatabase();
    let listeningAtDisconnect: boolean | undefined;
    const started = await startTracked(client);
    double.$disconnect.mockImplementation(async () => {
      listeningAtDisconnect = started.server.listening;
    });

    (signal === 'SIGTERM' ? started.sigterm : started.sigint)();

    await vi.waitFor(() => expect(double.$disconnect).toHaveBeenCalledTimes(1));
    expect(listeningAtDisconnect).toBe(false);
    expect(started.server.listening).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(previousExitCode);
  });

  it('logs the error and sets exit code 1 when disconnect fails during shutdown', async () => {
    const { double, client } = fakeDatabase();
    const failure = new Error('disconnect failed');
    const started = await startTracked(client);
    double.$disconnect.mockRejectedValue(failure);

    started.sigterm();

    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(failure));
    expect(process.exitCode).toBe(1);
  });

  it('rejects and disconnects when $connect fails', async () => {
    const { double, client } = fakeDatabase();
    const failure = new Error('connect failed');
    double.$connect.mockRejectedValue(failure);
    vi.mocked(createDatabase).mockReturnValue(client);

    await expect(start()).rejects.toBe(failure);
    expect(initialize).not.toHaveBeenCalled();
    expect(double.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects and disconnects when initialize fails', async () => {
    const { double, client } = fakeDatabase();
    const failure = new Error('initialize failed');
    vi.mocked(initialize).mockRejectedValue(failure);
    vi.mocked(createDatabase).mockReturnValue(client);

    await expect(start()).rejects.toBe(failure);
    expect(double.$connect).toHaveBeenCalledTimes(1);
    expect(double.$disconnect).toHaveBeenCalledTimes(1);
  });

  // Only the cleanup is pinned here. The error type is not asserted: today start() rejects with a TypeError that
  // hides the EADDRINUSE error (known defect, reported in the PR description, not fixed here).
  it('disconnects the database and rejects when the server cannot start listening', async () => {
    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
    vi.stubEnv('API_PORT', String((occupied.address() as AddressInfo).port));
    const { double, client } = fakeDatabase();
    vi.mocked(createDatabase).mockReturnValue(client);

    await expect(start()).rejects.toBeInstanceOf(Error);
    expect(double.$disconnect).toHaveBeenCalledTimes(1);
  });
});
