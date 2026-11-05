import {
  ANNOUNCE_PROVIDER_EVENT,
  BdxRpcError,
  BeldexWeb3,
  ERROR_CODES,
  PostMessageProvider,
  checkAddress,
  detectProvider,
  fromAtomic,
  type OperationStatus,
  type TokenBalance,
  type TokenBalances,
  type TokenInfo,
  type BeldexProvider,
} from '@bdxi/web3js';

export type WalletStatus =
  | 'detecting'
  | 'not_detected'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'locked'
  | 'unsupported';

export type WalletConnectionState = {
  status: WalletStatus;
  network?: string;
  address?: string;
  totalBalance?: string;
  unlockedBalance?: string;
  balanceLoading?: boolean;
  approximate?: boolean;
  error?: string;
  balanceError?: string;
};

export type AddressValidation = {
  valid: boolean;
  reason?: string;
  normalizedAddress?: string;
};

export type BeldexSendResult =
  | { status: 'submitted'; txHash: string; fee: string; operationId?: string }
  | { status: 'unresolved'; idempotencyKey: string };

const BDX_ATOMIC_UNITS = 1_000_000_000n;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const SUPPORTED_NETWORKS = new Set(['mainnet', 'testnet']);
const TARGET_NETWORK = 'testnet';
const PROVIDER_DETECTION_TIMEOUT_MS = 3000;
const BRIDGE_PROBE_TIMEOUT_MS = 1500;
type WalletListener = (state: WalletConnectionState) => void;
type ProviderListener = () => void;
type WalletEvent = (data: unknown) => void;
type WalletEventName =
  | 'connect'
  | 'disconnect'
  | 'accountsChanged'
  | 'networkChanged'
  | 'balanceChanged'
  | 'lock'
  | 'unlock';

let walletClient: BeldexWeb3 | undefined;
let ownedBridgeProvider: PostMessageProvider | undefined;
let currentState: WalletConnectionState = { status: 'detecting' };
let boundEventListeners: Array<[WalletEventName, WalletEvent]> = [];
let providerDetection: Promise<BeldexProvider | null> | undefined;
const stateListeners = new Set<WalletListener>();

function parseBDXAmount(value: string, allowZero = false): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error('Use a valid decimal amount.');
  }

  const [wholePart, fractionPart = ''] = trimmed.split('.');
  if (fractionPart.length > 9) {
    throw new Error('BDX amounts support up to 9 decimal places.');
  }

  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
  const atomic =
    BigInt(whole) * BDX_ATOMIC_UNITS +
    (fractionPart ? BigInt(fractionPart.padEnd(9, '0')) : 0n);
  if (!allowZero && atomic <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return atomic;
}

export function toAtomicBDX(amount: string): bigint {
  return parseBDXAmount(amount);
}

export function fromAtomicBDX(value: bigint | string): string {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw new Error('Atomic BDX value must be a non-negative integer.');
  }
  const atomic = typeof value === 'string' ? BigInt(value.trim()) : value;
  if (atomic < 0n) {
    throw new Error('Atomic BDX value must be a non-negative integer.');
  }
  return fromAtomic(atomic);
}

export function validateBeldexAddress(value: string, network?: string): AddressValidation {
  const address = value.trim();
  if (!address) {
    return { valid: false, reason: 'Recipient address is required.' };
  }
  if (!network || !SUPPORTED_NETWORKS.has(network)) {
    return { valid: false, reason: 'Wallet network is unavailable. Reconnect before sending.' };
  }

  const result = checkAddress(address, network as 'mainnet' | 'testnet');
  if (!result.valid) {
    return {
      valid: false,
      reason: result.reason ?? 'Enter a valid Beldex address for the connected network.',
    };
  }
  return { valid: true, normalizedAddress: address };
}

export function validateAmount(value: string): string | null {
  if (!value.trim()) {
    return 'Amount is required.';
  }
  try {
    parseBDXAmount(value);
    return null;
  } catch (error) {
    if (/^0+(?:\.0+)?$/.test(value.trim())) {
      return 'Amount must be greater than zero.';
    }
    return error instanceof Error ? error.message : 'Amount is invalid.';
  }
}

export function fitsAmount(value: string, balance?: string): string | null {
  if (balance === undefined) {
    return 'Wallet balance is unavailable. Refresh the wallet before sending.';
  }
  try {
    if (parseBDXAmount(value) > parseBDXAmount(balance, true)) {
      return 'Amount exceeds the unlocked wallet balance. Network fees are handled by the wallet.';
    }
    return null;
  } catch {
    return 'Amount or wallet balance is invalid.';
  }
}

export function getWalletStatusLabel(status: WalletStatus, network?: string): string {
  switch (status) {
    case 'detecting':
      return 'Checking wallet';
    case 'not_detected':
      return 'Wallet not detected';
    case 'connected':
      return network === TARGET_NETWORK
        ? 'Connected · Testnet verified'
        : network
          ? 'Wrong network'
          : 'Connected';
    case 'connecting':
      return 'Approval pending';
    case 'error':
      return 'Error';
    case 'locked':
      return 'Wallet locked';
    case 'unsupported':
      return 'Unsupported provider';
    default:
      return 'Disconnected';
  }
}

function notify(state: WalletConnectionState): WalletConnectionState {
  currentState = state;
  stateListeners.forEach((listener) => listener(state));
  return state;
}

function unbindWalletEvents(): void {
  if (walletClient) {
    boundEventListeners.forEach(([event, listener]) => walletClient?.off(event, listener));
  }
  boundEventListeners = [];
}

function setWalletClient(provider: BeldexProvider): BeldexWeb3 {
  if (walletClient?.provider === provider) {
    return walletClient;
  }
  unbindWalletEvents();
  const previousProvider = walletClient?.provider;
  walletClient = new BeldexWeb3(provider);
  if (ownedBridgeProvider && previousProvider === ownedBridgeProvider && provider !== ownedBridgeProvider) {
    ownedBridgeProvider.destroy();
    ownedBridgeProvider = undefined;
  }
  bindWalletEvents();
  return walletClient;
}

function clearWalletClient(): void {
  unbindWalletEvents();
  walletClient = undefined;
  ownedBridgeProvider?.destroy();
  ownedBridgeProvider = undefined;
}

function bindWalletEvents(): void {
  if (!walletClient || stateListeners.size === 0 || boundEventListeners.length > 0) {
    return;
  }

  const client = walletClient;
  const handlers: Array<[WalletEventName, WalletEvent]> = [
    ['connect', (data) => {
      const event = data as { address?: unknown; network?: unknown } | undefined;
      if (typeof event?.address === 'string' && typeof event.network === 'string') {
        void updateConnectedState(client, event.address, event.network);
      }
    }],
    ['disconnect', () => {
      notify({ status: 'disconnected', error: 'Wallet access was disconnected or revoked.' });
    }],
    ['accountsChanged', (data) => {
      const address = (data as { address?: unknown } | undefined)?.address;
      if (typeof address !== 'string' || !address.trim()) {
        notify({ status: 'disconnected', error: 'The active wallet changed. Connect again to continue.' });
        return;
      }
      const network = client.network;
      if (network) {
        void updateConnectedState(client, address, network);
      }
    }],
    ['networkChanged', () => {
      void refreshConnection(client);
    }],
    ['balanceChanged', () => {
      void refreshBalance(client);
    }],
    ['lock', () => {
      notify({ status: 'locked', error: 'The Beldex Wallet is locked. Unlock it, then reconnect.' });
    }],
    ['unlock', () => {
      notify({ status: 'disconnected', error: 'Wallet unlocked. Connect again to continue.' });
    }],
  ];

  handlers.forEach(([event, listener]) => client.on(event, listener));
  boundEventListeners = handlers;
}

function asConnectedState(
  address: string,
  network: string,
  balance?: Awaited<ReturnType<BeldexWeb3['getBalance']>>,
  balanceError?: string,
): WalletConnectionState {
  return {
    status: 'connected',
    address,
    network,
    error: network === TARGET_NETWORK
      ? undefined
      : `Connected to Beldex ${network}. Switch the wallet to Testnet for VeilPay.`,
    totalBalance: balance ? fromAtomic(balance.total) : undefined,
    unlockedBalance: balance ? fromAtomic(balance.unlocked) : undefined,
    balanceLoading: false,
    approximate: balance?.approximate,
    balanceError,
  };
}

async function updateConnectedState(
  client: BeldexWeb3,
  address: string,
  network: string,
): Promise<WalletConnectionState> {
  if (
    !address.trim() ||
    address !== address.trim() ||
    !SUPPORTED_NETWORKS.has(network) ||
    !checkAddress(address, network as 'mainnet' | 'testnet').valid
  ) {
    return notify({
      status: 'error',
      error: 'The wallet returned an invalid address or unsupported network.',
    });
  }
  notify({
    status: 'connected',
    address,
    network,
    error: network === TARGET_NETWORK
      ? undefined
      : `Connected to Beldex ${network}. Switch the wallet to Testnet for VeilPay.`,
    balanceLoading: true,
  });
  try {
    const balance = await client.getBalance();
    return notify(asConnectedState(address, network, balance));
  } catch (error) {
    return notify(asConnectedState(address, network, undefined, walletErrorMessage(error)));
  }
}

async function refreshConnection(client: BeldexWeb3): Promise<WalletConnectionState> {
  try {
    const connection = await client.connect();
    return await updateConnectedState(client, connection.address, connection.network);
  } catch (error) {
    const message = walletErrorMessage(error);
    return notify({
      status: BeldexWeb3.isLocked(error) ? 'locked' : 'disconnected',
      error: message,
    });
  }
}

async function refreshBalance(client: BeldexWeb3): Promise<WalletConnectionState> {
  if (currentState.status !== 'connected') {
    return currentState;
  }
  if (!client.isConnected || !client.address || !client.network) {
    return notify({ status: 'disconnected', error: 'Connect the wallet to read its balance.' });
  }
  notify({
    ...currentState,
    status: 'connected',
    address: client.address,
    network: client.network,
    balanceLoading: true,
    balanceError: undefined,
  });
  try {
    const balance = await client.getBalance();
    return notify(asConnectedState(client.address, client.network, balance));
  } catch (error) {
    return notify(asConnectedState(client.address, client.network, undefined, walletErrorMessage(error)));
  }
}

export function subscribeWallet(listener: WalletListener): () => void {
  stateListeners.add(listener);
  bindWalletEvents();
  return () => {
    stateListeners.delete(listener);
    if (stateListeners.size === 0) {
      unbindWalletEvents();
    }
  };
}

export function subscribeWalletProvider(listener: ProviderListener): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const onProviderAnnouncement = () => listener();
  window.addEventListener(ANNOUNCE_PROVIDER_EVENT, onProviderAnnouncement);
  return () => window.removeEventListener(ANNOUNCE_PROVIDER_EVENT, onProviderAnnouncement);
}

function detectBeldexProvider(): Promise<BeldexProvider | null> {
  if (!providerDetection) {
    providerDetection = discoverBeldexProvider().finally(() => {
      providerDetection = undefined;
    });
  }
  return providerDetection;
}

function isBeldexProvider(value: unknown): value is BeldexProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isBeldex' in value &&
    value.isBeldex === true &&
    'request' in value &&
    typeof value.request === 'function' &&
    'on' in value &&
    typeof value.on === 'function' &&
    'off' in value &&
    typeof value.off === 'function'
  );
}

function getInjectedProvider(): BeldexProvider | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const injected = (window as Window & { beldex?: unknown }).beldex;
  return isBeldexProvider(injected) ? injected : null;
}

async function detectPostMessageProvider(): Promise<BeldexProvider | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  const provider = new PostMessageProvider({ requestTimeoutMs: BRIDGE_PROBE_TIMEOUT_MS });
  try {
    const state: unknown = await provider.request({ method: 'bdx_getState' });
    if (
      typeof state !== 'object' ||
      state === null ||
      !('state' in state) ||
      (state.state !== 'locked' && state.state !== 'unlocked' && state.state !== 'no-wallet')
    ) {
      throw new Error('The Beldex Wallet bridge returned an invalid wallet state.');
    }
    ownedBridgeProvider = provider;
    return provider;
  } catch (error) {
    provider.destroy();
    if (error instanceof BdxRpcError && error.code === ERROR_CODES.REQUEST_EXPIRED) {
      return null;
    }
    if (error instanceof BdxRpcError && error.code === ERROR_CODES.METHOD_NOT_FOUND) {
      return null;
    }
    throw error;
  }
}

async function discoverBeldexProvider(): Promise<BeldexProvider | null> {
  const announcedProvider = await detectProvider({ timeoutMs: PROVIDER_DETECTION_TIMEOUT_MS });
  if (announcedProvider) {
    return announcedProvider;
  }
  const injectedProvider = getInjectedProvider();
  if (injectedProvider) {
    return injectedProvider;
  }
  return detectPostMessageProvider();
}

function hasUnsupportedInjectedProvider(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const injected = (window as Window & { beldex?: unknown }).beldex;
  if (injected === undefined || injected === null) {
    return false;
  }
  return !isBeldexProvider(injected);
}

function providerUnavailableState(): WalletConnectionState {
  if (hasUnsupportedInjectedProvider()) {
    return notify({
      status: 'unsupported',
      error: 'An incompatible provider is exposed as window.beldex. Disable it or install the official Beldex Wallet Extension.',
    });
  }
  return notify({
    status: 'not_detected',
    error: 'Beldex Wallet was not detected. Install or enable the official extension, then retry.',
  });
}

export async function detectWallet(): Promise<WalletConnectionState> {
  try {
    const provider = await detectBeldexProvider();
    if (!provider) {
      clearWalletClient();
      return providerUnavailableState();
    }

    const client = setWalletClient(provider);
    if (client.isConnected && currentState.status === 'connected') {
      return currentState;
    }
    return notify({ status: 'disconnected', error: 'Beldex Wallet detected. Connect to continue.' });
  } catch (error) {
    clearWalletClient();
    return notify({ status: 'error', error: walletErrorMessage(error) });
  }
}

export async function connectWallet(): Promise<WalletConnectionState> {
  try {
    let client = walletClient;
    if (!client) {
      notify({
        status: 'detecting',
        error: 'Checking for the Beldex Wallet extension before requesting access.',
      });
      const provider = await detectBeldexProvider();
      if (!provider) {
        return providerUnavailableState();
      }
      client = setWalletClient(provider);
    }

    notify({
      status: 'connecting',
      error: 'Waiting for approval in the Beldex Wallet extension. Open the extension, unlock the wallet, and approve or reject the request.',
    });
    const connection = await client.connect();
    return await updateConnectedState(client, connection.address, connection.network);
  } catch (error) {
    return notify({
      status: BeldexWeb3.isLocked(error)
        ? 'locked'
        : BeldexWeb3.isUserRejection(error)
          ? 'disconnected'
          : 'error',
      error: walletErrorMessage(error),
    });
  }
}

export async function disconnectWallet(): Promise<WalletConnectionState> {
  if (!walletClient?.isConnected) {
    return notify({ status: 'disconnected', error: 'No connected Beldex wallet to disconnect.' });
  }
  try {
    await walletClient.disconnect();
    return notify({ status: 'disconnected', error: 'Wallet disconnected.' });
  } catch (error) {
    return notify({ ...currentState, error: walletErrorMessage(error) });
  }
}

export async function refreshWalletBalance(): Promise<WalletConnectionState> {
  if (!walletClient) {
    return detectWallet();
  }
  return refreshBalance(walletClient);
}

export function createIdempotencyKey(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure randomness is unavailable; the transaction was not requested.');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireConnectedTestnetWallet(): BeldexWeb3 {
  if (
    !walletClient?.isConnected ||
    walletClient.network !== 'testnet' ||
    currentState.status !== 'connected' ||
    currentState.network !== 'testnet' ||
    currentState.address !== walletClient.address
  ) {
    throw new Error('Connect a Beldex Testnet wallet before continuing.');
  }
  return walletClient;
}

function supportsWalletVersion(version: string | undefined, minimum: [number, number]): boolean {
  if (!version) {
    return false;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    return false;
  }
  const major = BigInt(match[1]);
  const minor = BigInt(match[2]);
  return (
    major > BigInt(minimum[0]) ||
    (major === BigInt(minimum[0]) && minor >= BigInt(minimum[1]))
  );
}

async function requireFreshTestnetWallet(
  minimumVersion: [number, number],
  expectedAddress?: string,
): Promise<BeldexWeb3> {
  const client = requireConnectedTestnetWallet();
  const [network, address] = await Promise.all([client.getNetwork(), client.getAddress()]);
  if (network.nettype !== TARGET_NETWORK) {
    throw new Error('The active Beldex network is not Testnet. Switch the wallet to Testnet before continuing.');
  }
  if (client.network !== TARGET_NETWORK || currentState.network !== TARGET_NETWORK) {
    throw new Error('The active wallet or network changed. Reconnect to the Beldex Testnet wallet before continuing.');
  }
  if (
    !address ||
    address !== client.address ||
    address !== currentState.address ||
    (expectedAddress !== undefined && address !== expectedAddress)
  ) {
    throw new Error('The active wallet account changed. Reconnect the originating Beldex wallet before continuing.');
  }
  if (!supportsWalletVersion(network.walletVersion, minimumVersion)) {
    const requiredVersion = `${minimumVersion[0]}.${minimumVersion[1]}`;
    throw new Error(
      `The connected wallet version could not be verified or is unsupported. Beldex Wallet ${requiredVersion}+ is required.`,
    );
  }
  return client;
}

function validatePrivacyTokenId(tokenId: string): void {
  if (!TOKEN_ID_PATTERN.test(tokenId)) {
    throw new Error('Enter a valid Beldex Privacy Token ID.');
  }
}

export async function getPrivacyTokenBalances(tokenIds?: string[]): Promise<TokenBalances> {
  const client = requireConnectedTestnetWallet();
  if (tokenIds && (tokenIds.length > 16 || tokenIds.some((tokenId) => !TOKEN_ID_PATTERN.test(tokenId)))) {
    throw new Error('Privacy Token lookups accept at most 16 valid token IDs.');
  }
  return client.getTokenBalances(tokenIds);
}

export async function getPrivacyTokenBalance(tokenId: string): Promise<TokenBalance> {
  validatePrivacyTokenId(tokenId);
  return requireConnectedTestnetWallet().getTokenBalance(tokenId);
}

export async function getPrivacyTokenInfo(tokenId: string): Promise<TokenInfo> {
  validatePrivacyTokenId(tokenId);
  const info = await requireConnectedTestnetWallet().getTokenInfo(tokenId);
  if (
    info.tokenId !== tokenId ||
    !Number.isInteger(info.decimalPoint) ||
    info.decimalPoint < 0 ||
    info.decimalPoint > 18
  ) {
    throw new Error('The wallet returned invalid Privacy Token metadata.');
  }
  return info;
}

export function privacyTokenReadErrorMessage(error: unknown): string {
  if (BeldexWeb3.isUnauthorized(error)) {
    return 'Privacy Token read permission is required. Grant access in the Beldex Wallet, then try again.';
  }
  if (BeldexWeb3.isUserRejection(error)) {
    return 'Privacy Token read permission was rejected. Grant access in the Beldex Wallet to read token data.';
  }
  if (error instanceof BdxRpcError && error.code === ERROR_CODES.INVALID_PARAMS) {
    return 'The Privacy Token was not found or the token ID is invalid.';
  }
  return walletErrorMessage(error);
}

export async function getBeldexOperationStatus(
  operationId: string,
  expectedWalletAddress: string,
): Promise<OperationStatus> {
  if (!operationId.trim() || operationId.length > 128) {
    throw new Error('A valid wallet operation ID is required.');
  }
  if (!expectedWalletAddress.trim()) {
    throw new Error('The originating wallet address is required to check this operation.');
  }
  const client = await requireFreshTestnetWallet([1, 2], expectedWalletAddress);
  return client.getOperationStatus(operationId);
}

export async function sendBeldexTransaction(
  recipient: string,
  amount: string,
  idempotencyKey: string,
  expectedWalletAddress: string,
): Promise<BeldexSendResult> {
  const atomicAmount = toAtomicBDX(amount);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new Error('Use a valid wallet-compatible transaction idempotency key.');
  }
  if (!expectedWalletAddress.trim()) {
    throw new Error('The originating wallet address is required before sending.');
  }
  const addressCheck = validateBeldexAddress(recipient, 'testnet');
  if (!addressCheck.valid) {
    throw new Error(addressCheck.reason ?? 'Enter a valid Beldex Testnet recipient address.');
  }
  const client = await requireFreshTestnetWallet([1, 2], expectedWalletAddress);
  const result = await client.sendTransactionSafe({
    to: addressCheck.normalizedAddress ?? recipient,
    amount: atomicAmount,
    idempotencyKey,
  });
  if (result.status === 'unresolved') {
    return result;
  }
  return {
    status: 'submitted',
    txHash: result.txHash,
    fee: fromAtomic(BigInt(result.fee)),
    operationId: result.operationId,
  };
}

export function walletErrorMessage(error: unknown): string {
  if (BeldexWeb3.isUserRejection(error)) {
    return 'Wallet approval was rejected. No successful submission was reported.';
  }
  if (BeldexWeb3.isLocked(error)) {
    return 'The Beldex Wallet is locked. Unlock it and try again.';
  }
  if (BdxRpcError.isUnknownOutcome(error)) {
    return 'The wallet could not determine the transaction outcome. Do not start a new payment; retry only with the same payment details.';
  }
  return error instanceof Error ? error.message : 'The Beldex Wallet request failed.';
}
