import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_PROVIDER_EVENT,
  BdxRpcError,
  ERROR_CODES,
  REQUEST_PROVIDER_EVENT,
  REQUEST_TARGET,
  RESPONSE_TARGET,
  type BeldexProvider,
} from '@bdxi/web3js';

describe('Beldex SDK provider discovery integration', () => {
  let adapter: typeof import('./beldexAdapter');
  let originalBeldex: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.resetModules();
    originalBeldex = Object.getOwnPropertyDescriptor(window, 'beldex');
    Reflect.deleteProperty(window, 'beldex');
    adapter = await import('./beldexAdapter');
  });

  afterEach(() => {
    if (originalBeldex) {
      Object.defineProperty(window, 'beldex', originalBeldex);
    } else {
      Reflect.deleteProperty(window, 'beldex');
    }
    vi.useRealTimers();
  });

  function makeProvider(request = vi.fn()): BeldexProvider {
    return {
      isBeldex: true,
      request,
      on: vi.fn(),
      off: vi.fn(),
    };
  }

  it('detects an SDK-compatible provider injected before the page initializes', async () => {
    const provider = makeProvider();
    Object.defineProperty(window, 'beldex', { configurable: true, value: provider });

    await expect(adapter.detectWallet()).resolves.toMatchObject({
      status: 'disconnected',
      error: expect.stringContaining('Beldex Wallet detected'),
    });
  });

  it('detects an announced provider using the SDK event name and payload contract', async () => {
    const provider = makeProvider();
    window.addEventListener(REQUEST_PROVIDER_EVENT, () => {
      window.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, {
        detail: {
          info: {
            uuid: 'page-instance',
            name: 'Beldex Wallet',
            icon: 'data:image/svg+xml,',
            rdns: 'io.beldex.wallet',
          },
          provider,
        },
      }));
    }, { once: true });

    await expect(adapter.detectWallet()).resolves.toMatchObject({
      status: 'disconnected',
      error: expect.stringContaining('Beldex Wallet detected'),
    });
  });

  it('finds a provider injected late during the SDK discovery window', async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    const timer = window.setTimeout(() => {
      Object.defineProperty(window, 'beldex', { configurable: true, value: provider });
    }, 2990);
    const detection = adapter.detectWallet();

    await vi.advanceTimersByTimeAsync(3000);
    window.clearTimeout(timer);
    await expect(detection).resolves.toMatchObject({ status: 'disconnected' });
  });

  it('uses the SDK postMessage transport when the extension has no in-page provider object', async () => {
    let locked = true;
    const address = '9'.repeat(95);
    const handledMethods: string[] = [];
    const reply = (data: unknown) => {
      window.dispatchEvent(new MessageEvent('message', { source: window, data }));
    };
    const onMessage = (event: MessageEvent) => {
      const request = event.data;
      if (request?.target !== REQUEST_TARGET || typeof request.id !== 'string') {
        return;
      }
      handledMethods.push(request.method);
      if (request.method === 'bdx_getState') {
        reply({
          target: RESPONSE_TARGET,
          id: request.id,
          result: { state: locked ? 'locked' : 'unlocked' },
        });
      } else if (request.method === 'bdx_connect') {
        reply(locked
          ? {
              target: RESPONSE_TARGET,
              id: request.id,
              error: { code: ERROR_CODES.WALLET_LOCKED, message: 'Wallet locked' },
            }
          : {
              target: RESPONSE_TARGET,
              id: request.id,
              result: { address, network: 'testnet' },
            });
      } else if (request.method === 'bdx_getBalance') {
        reply({
          target: RESPONSE_TARGET,
          id: request.id,
          result: { total: '100', unlocked: '50', approximate: false, height: 7 },
        });
      }
    };
    window.addEventListener('message', onMessage);

    try {
      await expect(adapter.detectWallet()).resolves.toMatchObject({ status: 'disconnected' });
      await expect(adapter.connectWallet()).resolves.toMatchObject({
        status: 'locked',
      });

      locked = false;
      await expect(adapter.connectWallet()).resolves.toMatchObject({
        status: 'connected',
        address,
        network: 'testnet',
      });
      expect(handledMethods).toEqual(['bdx_getState', 'bdx_connect', 'bdx_connect', 'bdx_getBalance']);

      window.removeEventListener('message', onMessage);
      const removeListener = vi.spyOn(window, 'removeEventListener');
      await expect(adapter.detectWallet()).resolves.toMatchObject({ status: 'not_detected' });
      expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
      removeListener.mockRestore();
    } finally {
      window.removeEventListener('message', onMessage);
    }
  }, 10_000);

  it('returns not detected when the SDK bridge does not respond', async () => {
    await expect(adapter.detectWallet()).resolves.toMatchObject({ status: 'not_detected' });
  }, 10_000);

  it('returns not detected when the SDK bridge reports an unsupported method', async () => {
    const onMessage = (event: MessageEvent) => {
      const request = event.data;
      if (
        request?.target === REQUEST_TARGET &&
        request.method === 'bdx_getState' &&
        typeof request.id === 'string'
      ) {
        window.dispatchEvent(new MessageEvent('message', {
          source: window,
          data: {
            target: RESPONSE_TARGET,
            id: request.id,
            error: { code: ERROR_CODES.METHOD_NOT_FOUND, message: 'Unknown method' },
          },
        }));
      }
    };
    window.addEventListener('message', onMessage);
    try {
      await expect(adapter.detectWallet()).resolves.toMatchObject({ status: 'not_detected' });
    } finally {
      window.removeEventListener('message', onMessage);
    }
  }, 10_000);

  it('waits for approval, handles user rejection, and only verifies the wallet-returned network', async () => {
    let resolveConnect: ((result: unknown) => void) | undefined;
    let rejectConnect: ((error: Error) => void) | undefined;
    const provider = makeProvider(vi.fn(({ method }: { method: string }) => {
      if (method === 'bdx_connect') {
        return new Promise((resolve, reject) => {
          resolveConnect = resolve;
          rejectConnect = reject;
        });
      }
      if (method === 'bdx_getBalance') {
        return Promise.resolve({ total: '0', unlocked: '0', approximate: false, height: 1 });
      }
      return Promise.resolve(undefined);
    }));
    Object.defineProperty(window, 'beldex', { configurable: true, value: provider });

    const updates: Array<{ status: string }> = [];
    const unsubscribe = adapter.subscribeWallet((state) => updates.push(state));
    const pending = adapter.connectWallet();
    await vi.waitFor(() => {
      expect(updates).toContainEqual(expect.objectContaining({ status: 'connecting' }));
    });
    rejectConnect?.(new BdxRpcError(ERROR_CODES.USER_REJECTED, 'User rejected'));
    await expect(pending).resolves.toMatchObject({ status: 'disconnected' });

    const wrongNetwork = adapter.connectWallet();
    resolveConnect?.({ address: `bx${'1'.repeat(93)}`, network: 'mainnet' });
    await expect(wrongNetwork).resolves.toMatchObject({
      status: 'connected',
      network: 'mainnet',
      error: expect.stringContaining('Switch the wallet to Testnet'),
    });
    unsubscribe();
  });

  it('reuses one initialized client and removes app event handlers on unsubscribe', async () => {
    const provider = makeProvider();
    Object.defineProperty(window, 'beldex', { configurable: true, value: provider });
    const unsubscribe = adapter.subscribeWallet(vi.fn());
    await adapter.detectWallet();
    const onCalls = vi.mocked(provider.on).mock.calls.length;

    await adapter.detectWallet();
    expect(vi.mocked(provider.on)).toHaveBeenCalledTimes(onCalls);

    unsubscribe();
    expect(vi.mocked(provider.off)).toHaveBeenCalledTimes(7);
  });
});
