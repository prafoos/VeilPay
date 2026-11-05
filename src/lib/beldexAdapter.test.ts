import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BdxRpcError, ERROR_CODES } from '@bdxi/web3js';
import {
  connectWallet,
  createIdempotencyKey,
  detectWallet,
  disconnectWallet,
  fitsAmount,
  fromAtomicBDX,
  getWalletStatusLabel,
  getBeldexOperationStatus,
  getPrivacyTokenBalance,
  getPrivacyTokenBalances,
  getPrivacyTokenInfo,
  privacyTokenReadErrorMessage,
  refreshWalletBalance,
  sendBeldexTransaction,
  subscribeWallet,
  subscribeWalletProvider,
  toAtomicBDX,
  validateAmount,
  validateBeldexAddress,
} from './beldexAdapter';

const sdkMocks = vi.hoisted(() => ({
  detectProvider: vi.fn(),
  checkAddress: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  getBalance: vi.fn(),
  getAddress: vi.fn(),
  getNetwork: vi.fn(),
  getTokenBalance: vi.fn(),
  getTokenBalances: vi.fn(),
  getTokenInfo: vi.fn(),
  getOperationStatus: vi.fn(),
  sendTransactionSafe: vi.fn(),
  isUserRejection: vi.fn(() => false),
  isUnauthorized: vi.fn(() => false),
  isLocked: vi.fn(() => false),
  isUnknownOutcome: vi.fn(() => false),
  instance: null as null | {
    address: string | null;
    emit: (event: string, data?: unknown) => void;
    network: 'mainnet' | 'testnet' | null;
    off: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('@bdxi/web3js', async () => {
  const actual = await vi.importActual<typeof import('@bdxi/web3js')>('@bdxi/web3js');

  return {
    ...actual,
    detectProvider: sdkMocks.detectProvider,
    checkAddress: sdkMocks.checkAddress,
    BeldexWeb3: class {
      static isUserRejection = sdkMocks.isUserRejection;
      static isUnauthorized = sdkMocks.isUnauthorized;
      static isLocked = sdkMocks.isLocked;
      static isUnknownOutcome = sdkMocks.isUnknownOutcome;
      readonly provider: { isBeldex: true };
      address: string | null = null;
      network: 'mainnet' | 'testnet' | null = null;
      isConnected = false;
      private listeners = new Map<string, Set<(data: unknown) => void>>();

      constructor(provider: { isBeldex: true }) {
        this.provider = provider;
        sdkMocks.instance = this;
      }

      connect = async () => {
        const result = await sdkMocks.connect();
        this.address = result.address;
        this.network = result.network;
        this.isConnected = true;
        return result;
      };
      disconnect = async () => {
        await sdkMocks.disconnect();
        this.address = null;
        this.network = null;
        this.isConnected = false;
      };
      getBalance = sdkMocks.getBalance;
      getAddress = sdkMocks.getAddress;
      getNetwork = sdkMocks.getNetwork;
      getTokenBalance = sdkMocks.getTokenBalance;
      getTokenBalances = sdkMocks.getTokenBalances;
      getTokenInfo = sdkMocks.getTokenInfo;
      getOperationStatus = sdkMocks.getOperationStatus;
      sendTransactionSafe = sdkMocks.sendTransactionSafe;
      on = vi.fn((event: string, listener: (data: unknown) => void) => {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
      });

      off = vi.fn((event: string, listener: (data: unknown) => void) => {
        this.listeners.get(event)?.delete(listener);
      });
      emit = (event: string, data?: unknown) => {
        this.listeners.get(event)?.forEach((listener) => listener(data));
      };
    },
  };
});

const successfulBalance = {
  total: 2_500_000_000n,
  unlocked: 1_250_000_000n,
  approximate: false,
  height: 42,
};

function installProvider() {
  const provider = {
    isBeldex: true as const,
    request: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  sdkMocks.detectProvider.mockResolvedValue(provider);
  return provider;
}

describe('Beldex amount and address validation', () => {
  it('converts atomic units without floating-point rounding', () => {
    expect(toAtomicBDX('1')).toBe(1_000_000_000n);
    expect(toAtomicBDX('1.25')).toBe(1_250_000_000n);
    expect(toAtomicBDX('0.000000001')).toBe(1n);
    expect(fromAtomicBDX(1_250_000_000n)).toBe('1.25');
    expect(toAtomicBDX('1234567890123.123456789')).toBe(1_234_567_890_123_123_456_789n);
  });

  it('rejects invalid amounts and compares against the actual unlocked balance', () => {
    for (const value of ['', '0', '-1', '1e-3', 'abc', '0.1234567890']) {
      expect(validateAmount(value)).not.toBeNull();
    }
    expect(fitsAmount('1.25', '1.249999999')).toContain('exceeds');
    expect(fitsAmount('1.25', '1.25')).toBeNull();
    expect(fitsAmount('1', undefined)).toContain('unavailable');
  });

  it('uses the SDK address checker and requires the connected network', () => {
    sdkMocks.checkAddress.mockReturnValue({ valid: true, network: 'testnet' });
    expect(validateBeldexAddress('mock-address', 'testnet')).toMatchObject({
      valid: true,
      normalizedAddress: 'mock-address',
    });
    expect(validateBeldexAddress('mock-address')).toMatchObject({
      valid: false,
      reason: expect.stringContaining('network'),
    });
    sdkMocks.checkAddress.mockReturnValue({ valid: false, reason: 'Wrong network' });
    expect(validateBeldexAddress('mock-address', 'mainnet').reason).toBe('Wrong network');
  });
});

describe('Beldex wallet provider lifecycle', () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    sdkMocks.detectProvider.mockReset();
    sdkMocks.checkAddress.mockReset().mockReturnValue({ valid: true });
    sdkMocks.connect.mockReset().mockResolvedValue({
      address: 'mock-beldex-address',
      network: 'testnet',
    });
    sdkMocks.disconnect.mockReset().mockResolvedValue(undefined);
    sdkMocks.getBalance.mockReset().mockResolvedValue(successfulBalance);
    sdkMocks.getAddress.mockReset().mockResolvedValue('mock-beldex-address');
    sdkMocks.getNetwork.mockReset().mockImplementation(async () => ({
      nettype: sdkMocks.instance?.network ?? 'testnet',
      height: 42,
      protocolVersion: 1,
      walletVersion: '1.3.0',
    }));
    sdkMocks.getTokenBalance.mockReset().mockResolvedValue({
      tokenId: 'token123',
      status: 'confirmed',
      total: 250n,
      unlocked: 200n,
      locked: 50n,
      height: 42,
      ticker: 'TEST',
      decimalPoint: 6,
    });
    sdkMocks.getTokenBalances.mockReset().mockResolvedValue({ tokens: [], height: 42 });
    sdkMocks.getTokenInfo.mockReset().mockResolvedValue({
      tokenId: 'token123',
      ticker: 'TEST',
      name: 'Test Token',
      owner: 'mock-owner',
      metaInfo: '',
      currentSupply: '1000000',
      totalMaxSupply: '10000000',
      decimalPoint: 6,
    });
    sdkMocks.getOperationStatus.mockReset().mockResolvedValue({
      status: 'confirmed',
      operationId: 'operation123',
      txHash: 'wallet-returned-tx-id',
      fee: '1000000',
    });
    sdkMocks.sendTransactionSafe.mockReset();
    sdkMocks.isUserRejection.mockReset().mockReturnValue(false);
    sdkMocks.isUnauthorized.mockReset().mockReturnValue(false);
    sdkMocks.isLocked.mockReset().mockReturnValue(false);
    sdkMocks.isUnknownOutcome.mockReset().mockReturnValue(false);
    sdkMocks.instance = null;
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  it('reports an unavailable extension without claiming connection', async () => {
    sdkMocks.detectProvider.mockResolvedValue(null);
    expect(await detectWallet()).toMatchObject({
      status: 'not_detected',
      error: expect.stringContaining('was not detected'),
    });
  });

  it('distinguishes an incompatible window.beldex provider from a missing wallet', async () => {
    Object.defineProperty(window, 'beldex', {
      configurable: true,
      value: { request: vi.fn() },
    });
    sdkMocks.detectProvider.mockResolvedValue(null);

    expect(await detectWallet()).toMatchObject({
      status: 'unsupported',
      error: expect.stringContaining('incompatible provider'),
    });

    Reflect.deleteProperty(window, 'beldex');
  });

  it('recovers when the Beldex extension announces after initial detection timed out', async () => {
    const provider = installProvider();
    sdkMocks.detectProvider
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(provider);
    expect(await detectWallet()).toMatchObject({ status: 'not_detected' });

    let detected: ReturnType<typeof detectWallet> | undefined;
    unsubscribe = subscribeWalletProvider(() => {
      detected = detectWallet();
    });
    window.dispatchEvent(new CustomEvent('beldex:announceProvider'));

    await expect(detected).resolves.toMatchObject({
      status: 'disconnected',
      error: expect.stringContaining('Beldex Wallet detected'),
    });
  });

  it('waits safely for a delayed provider during SDK detection', async () => {
    const provider = installProvider();
    sdkMocks.detectProvider.mockImplementationOnce(
      () => new Promise((resolve) => window.setTimeout(() => resolve(provider), 0)),
    );

    await expect(detectWallet()).resolves.toMatchObject({
      status: 'disconnected',
      error: expect.stringContaining('Beldex Wallet detected'),
    });
  });

  it('labels pending approval, missing provider, wrong network, and verified Testnet distinctly', () => {
    expect(getWalletStatusLabel('not_detected')).toBe('Wallet not detected');
    expect(getWalletStatusLabel('unsupported')).toBe('Unsupported provider');
    expect(getWalletStatusLabel('connecting')).toBe('Approval pending');
    expect(getWalletStatusLabel('locked')).toBe('Wallet locked');
    expect(getWalletStatusLabel('connected', 'mainnet')).toBe('Wrong network');
    expect(getWalletStatusLabel('connected', 'testnet')).toBe('Connected · Testnet verified');
  });

  it('connects only after provider approval and reads actual total/unlocked balances', async () => {
    installProvider();
    expect(await connectWallet()).toMatchObject({
      status: 'connected',
      address: 'mock-beldex-address',
      network: 'testnet',
      totalBalance: '2.5',
      unlockedBalance: '1.25',
      approximate: false,
    });
  });

  it('keeps connection but reports a balance read error without inventing a value', async () => {
    installProvider();
    sdkMocks.getBalance.mockRejectedValue(new Error('Balance RPC unavailable'));
    expect(await connectWallet()).toMatchObject({
      status: 'connected',
      address: 'mock-beldex-address',
      totalBalance: undefined,
      unlockedBalance: undefined,
      balanceError: 'Balance RPC unavailable',
    });
  });

  it('publishes the connected loading state before resolving the provider balance', async () => {
    installProvider();
    let resolveBalance: ((balance: typeof successfulBalance) => void) | undefined;
    sdkMocks.getBalance.mockReturnValue(new Promise((resolve) => {
      resolveBalance = resolve;
    }));
    const updates: Array<{ status: string; balanceLoading?: boolean }> = [];
    unsubscribe = subscribeWallet((state) => updates.push(state));

    const connecting = connectWallet();
    await vi.waitFor(() => {
      expect(updates).toContainEqual(expect.objectContaining({
        status: 'connected',
        balanceLoading: true,
      }));
    });
    resolveBalance?.(successfulBalance);
    await expect(connecting).resolves.toMatchObject({
      status: 'connected',
      balanceLoading: false,
      unlockedBalance: '1.25',
    });
  });

  it('publishes an approval-pending state while the wallet request is unresolved', async () => {
    installProvider();
    let resolveConnection: ((result: { address: string; network: string }) => void) | undefined;
    sdkMocks.connect.mockReturnValueOnce(new Promise((resolve) => {
      resolveConnection = resolve;
    }));
    const updates: Array<{ status: string }> = [];
    unsubscribe = subscribeWallet((state) => updates.push(state));

    const connecting = connectWallet();
    await vi.waitFor(() => {
      expect(updates).toContainEqual(expect.objectContaining({ status: 'connecting' }));
    });
    resolveConnection?.({ address: 'mock-beldex-address', network: 'testnet' });
    await expect(connecting).resolves.toMatchObject({ status: 'connected', network: 'testnet' });
  });

  it('does not report a connection with an invalid address or unsupported network', async () => {
    installProvider();
    sdkMocks.connect.mockResolvedValueOnce({
      address: 'mock-beldex-address',
      network: 'stagenet',
    });
    expect(await connectWallet()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('unsupported network'),
    });
    expect(sdkMocks.getBalance).not.toHaveBeenCalled();

    sdkMocks.connect.mockResolvedValueOnce({
      address: 'not-an-address',
      network: 'mainnet',
    });
    sdkMocks.checkAddress.mockReturnValueOnce({ valid: false });
    expect(await connectWallet()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('invalid address'),
    });
  });

  it('reports rejected connections, locked wallets, and provider errors', async () => {
    installProvider();
    const rejection = new Error('User rejected');
    sdkMocks.connect.mockRejectedValueOnce(rejection);
    sdkMocks.isUserRejection.mockImplementation((error) => error === rejection);
    expect(await connectWallet()).toMatchObject({ status: 'disconnected', error: expect.stringContaining('rejected') });

    const lockedError = new Error('Wallet locked');
    sdkMocks.connect.mockRejectedValueOnce(lockedError);
    sdkMocks.isUserRejection.mockReturnValue(false);
    sdkMocks.isLocked.mockImplementation((error) => error === lockedError);
    expect(await connectWallet()).toMatchObject({ status: 'locked', error: expect.stringContaining('locked') });
    expect(await refreshWalletBalance()).toMatchObject({ status: 'locked' });

    sdkMocks.detectProvider.mockRejectedValue(new Error('Provider failed'));
    expect(await detectWallet()).toMatchObject({ status: 'error', error: 'Provider failed' });
  });

  it('synchronizes account, network, balance, and disconnect events, then removes listeners', async () => {
    installProvider();
    const listener = vi.fn();
    unsubscribe = subscribeWallet(listener);
    await connectWallet();
    const client = sdkMocks.instance;
    expect(client).not.toBeNull();

    client?.emit('accountsChanged', { address: null });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected' }));

    sdkMocks.connect.mockResolvedValueOnce({ address: 'network-address', network: 'mainnet' });
    client?.emit('networkChanged', { nettype: 'mainnet' });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
        status: 'connected',
        address: 'network-address',
        network: 'mainnet',
      }));
    });

    sdkMocks.getBalance.mockResolvedValueOnce({
      total: 3_000_000_000n,
      unlocked: 2_000_000_000n,
      approximate: true,
      height: 43,
    });
    client?.emit('balanceChanged', { total: '3000000000', unlocked: '2000000000', height: 43 });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
        totalBalance: '3',
        unlockedBalance: '2',
        approximate: true,
      }));
    });

    client?.emit('disconnect');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected' }));
    client?.emit('lock');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'locked' }));
    unsubscribe?.();
    unsubscribe = undefined;
    expect(client?.off).toHaveBeenCalledTimes(7);
  });

  it('requests actual wallet disconnection and safe, exact-amount transactions', async () => {
    installProvider();
    await connectWallet();
    await disconnectWallet();
    expect(sdkMocks.disconnect).toHaveBeenCalledOnce();

    await connectWallet();
    sdkMocks.getNetwork.mockResolvedValue({
      nettype: 'testnet',
      height: 42,
      protocolVersion: 1,
      walletVersion: '1.2.0',
    });
    sdkMocks.sendTransactionSafe.mockResolvedValue({
      status: 'confirmed',
      txHash: 'wallet-returned-tx-id',
      fee: '1000000',
    });
    await expect(sendBeldexTransaction('mock-recipient', '1.25', 'same-key-123', 'mock-beldex-address')).resolves.toEqual({
      status: 'submitted',
      txHash: 'wallet-returned-tx-id',
      fee: '0.001',
    });
    expect(sdkMocks.sendTransactionSafe).toHaveBeenCalledWith({
      to: 'mock-recipient',
      amount: 1_250_000_000n,
      idempotencyKey: 'same-key-123',
    });
    expect(sdkMocks.getNetwork).toHaveBeenCalled();
    expect(sdkMocks.getAddress).toHaveBeenCalled();

    sdkMocks.sendTransactionSafe.mockResolvedValue({
      status: 'unresolved',
      idempotencyKey: 'same-key-123',
    });
    await expect(sendBeldexTransaction('mock-recipient', '1.25', 'same-key-123', 'mock-beldex-address')).resolves.toEqual({
      status: 'unresolved',
      idempotencyKey: 'same-key-123',
    });
  });

  it('blocks BDX sends on Mainnet and unknown networks before the SDK send call', async () => {
    installProvider();
    sdkMocks.connect.mockResolvedValueOnce({
      address: 'mock-beldex-address',
      network: 'mainnet',
    });
    await connectWallet();
    await expect(sendBeldexTransaction('mock-recipient', '1', 'same-key-123', 'mock-beldex-address')).rejects.toThrow(
      'Beldex Testnet wallet',
    );
    expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();

    await disconnectWallet();
    installProvider();
    sdkMocks.connect.mockResolvedValueOnce({
      address: 'mock-beldex-address',
      network: 'unknown' as 'testnet',
    });
    await connectWallet();
    await expect(sendBeldexTransaction('mock-recipient', '1', 'same-key-123', 'mock-beldex-address')).rejects.toThrow(
      'Beldex Testnet wallet',
    );
    expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();

    await disconnectWallet();
    installProvider();
    sdkMocks.connect.mockResolvedValueOnce({
      address: 'mock-beldex-address',
      network: '' as 'testnet',
    });
    await connectWallet();
    await expect(sendBeldexTransaction('mock-recipient', '1', 'same-key-123', 'mock-beldex-address')).rejects.toThrow(
      'Beldex Testnet wallet',
    );
    expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();
  });

  it('rechecks the wallet network immediately before sending BDX', async () => {
    installProvider();
    await connectWallet();
    sdkMocks.getNetwork.mockResolvedValue({
      nettype: 'mainnet',
      height: 42,
      protocolVersion: 1,
      walletVersion: '1.3.0',
    });

    await expect(sendBeldexTransaction('mock-recipient', '1', 'same-key-123', 'mock-beldex-address')).rejects.toThrow(
      'not Testnet',
    );
    expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();
  });

  it('blocks BDX sends when the active account differs from the reviewed account', async () => {
    installProvider();
    await connectWallet();
    sdkMocks.getAddress.mockResolvedValue('different-active-account');

    await expect(
      sendBeldexTransaction('mock-recipient', '1', 'same-key-123', 'mock-beldex-address'),
    ).rejects.toThrow('active wallet account changed');
    expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();
  });

  it.each([undefined, '1.1.9', 'not-a-version'])(
    'blocks BDX safe sends when the wallet version is missing or unsupported (%s)',
    async (walletVersion) => {
      installProvider();
      await connectWallet();
      sdkMocks.getNetwork.mockResolvedValue({
        nettype: 'testnet',
        height: 42,
        protocolVersion: 1,
        walletVersion,
      });

      await expect(sendBeldexTransaction('mock-recipient', '1', 'same-key-123', 'mock-beldex-address')).rejects.toThrow(
        'version could not be verified or is unsupported',
      );
      expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();
    },
  );

  it('scopes operation-status reads to the originating account and Testnet', async () => {
    installProvider();
    await connectWallet();
    sdkMocks.getAddress.mockResolvedValue('different-active-account');

    await expect(
      getBeldexOperationStatus('operation123', 'mock-beldex-address'),
    ).rejects.toThrow('active wallet account changed');
    expect(sdkMocks.getOperationStatus).not.toHaveBeenCalled();

    sdkMocks.getAddress.mockResolvedValue('mock-beldex-address');
    sdkMocks.getNetwork.mockResolvedValue({
      nettype: 'mainnet',
      height: 42,
      protocolVersion: 1,
      walletVersion: '1.3.0',
    });
    await expect(
      getBeldexOperationStatus('operation123', 'mock-beldex-address'),
    ).rejects.toThrow('not Testnet');
    expect(sdkMocks.getOperationStatus).not.toHaveBeenCalled();
  });

  it('reads Privacy Token balances and metadata only through a connected Testnet wallet', async () => {
    await disconnectWallet();
    installProvider();
    await expect(getPrivacyTokenBalances()).rejects.toThrow('Connect a Beldex Testnet wallet');
    await connectWallet();

    const balances = { tokens: [{ tokenId: 'token123', status: 'confirmed', total: 250n, unlocked: 200n, locked: 50n, ticker: 'TEST', decimalPoint: 6 }], height: 42 };
    const info = {
      tokenId: 'token123',
      ticker: 'TEST',
      name: 'Test Token',
      owner: 'mock-owner',
      metaInfo: '',
      currentSupply: '1000000',
      totalMaxSupply: '10000000',
      decimalPoint: 6,
    };
    sdkMocks.getTokenBalances.mockResolvedValue(balances);
    sdkMocks.getTokenInfo.mockResolvedValue(info);

    await expect(getPrivacyTokenBalances(['token123'])).resolves.toEqual(balances);
    await expect(getPrivacyTokenInfo('token123')).resolves.toEqual(info);
    expect(sdkMocks.getTokenBalances).toHaveBeenCalledWith(['token123']);
    expect(sdkMocks.getTokenInfo).toHaveBeenCalledWith('token123');
    await expect(getPrivacyTokenBalance('token123')).resolves.toMatchObject({
      tokenId: 'token123',
      status: 'confirmed',
      total: 250n,
      height: 42,
    });
    expect(sdkMocks.getTokenBalance).toHaveBeenCalledWith('token123');
    expect(sdkMocks.sendTransactionSafe).not.toHaveBeenCalled();
    await expect(getPrivacyTokenInfo('invalid token id')).rejects.toThrow('valid Beldex Privacy Token ID');
    await expect(getPrivacyTokenBalance('invalid token id')).rejects.toThrow('valid Beldex Privacy Token ID');
    await expect(getPrivacyTokenBalances(Array.from({ length: 17 }, () => 'token123'))).rejects.toThrow(
      'at most 16',
    );
  });

  it('rejects Mainnet token access and validates token metadata and IDs', async () => {
    installProvider();
    sdkMocks.connect.mockResolvedValueOnce({
      address: 'mock-beldex-address',
      network: 'mainnet',
    });
    const state = await connectWallet();
    expect(state).toMatchObject({
      status: 'connected',
      network: 'mainnet',
      error: 'Connected to Beldex mainnet. Switch the wallet to Testnet for VeilPay.',
    });
    expect(getWalletStatusLabel(state.status, state.network)).toBe('Wrong network');

    await expect(getPrivacyTokenBalances()).rejects.toThrow('Connect a Beldex Testnet wallet');
    await expect(getPrivacyTokenBalance('token123')).rejects.toThrow('Connect a Beldex Testnet wallet');
    await expect(getPrivacyTokenInfo('token123')).rejects.toThrow('Connect a Beldex Testnet wallet');
    expect(sdkMocks.getTokenBalances).not.toHaveBeenCalled();
    expect(sdkMocks.getTokenBalance).not.toHaveBeenCalled();
    expect(sdkMocks.getTokenInfo).not.toHaveBeenCalled();
  });

  it('distinguishes missing Privacy Token read permission from SDK errors', () => {
    sdkMocks.isUnauthorized.mockReturnValueOnce(true);
    expect(privacyTokenReadErrorMessage(new Error('unauthorized'))).toContain('read permission is required');
    sdkMocks.isUserRejection.mockReturnValueOnce(true);
    expect(privacyTokenReadErrorMessage(new Error('rejected'))).toContain('read permission was rejected');
    expect(
      privacyTokenReadErrorMessage(new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'Invalid token')),
    ).toContain('was not found');
    expect(privacyTokenReadErrorMessage(new Error('SDK unavailable'))).toBe('SDK unavailable');
  });

  it('creates a wallet-compatible non-secret idempotency key', () => {
    const key = createIdempotencyKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
  });

  it('does not request balance reads while disconnected', async () => {
    installProvider();
    await detectWallet();
    expect(await refreshWalletBalance()).toMatchObject({ status: 'disconnected' });
    expect(sdkMocks.getBalance).not.toHaveBeenCalled();
  });
});
