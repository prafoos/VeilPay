import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import App from './App';

const walletAdapterMocks = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  createIdempotencyKey: vi.fn(() => 'test-idempotency-key-123'),
  detectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  fitsAmount: vi.fn(() => null),
  getPrivacyTokenBalance: vi.fn(),
  getPrivacyTokenBalances: vi.fn(),
  getPrivacyTokenInfo: vi.fn(),
  getBeldexOperationStatus: vi.fn(),
  getWalletStatusLabel: vi.fn((status: string, network?: string) => {
    if (status === 'not_detected') return 'Wallet not detected';
    if (status === 'unsupported') return 'Unsupported provider';
    if (status === 'connecting') return 'Approval pending';
    if (status === 'locked') return 'Wallet locked';
    if (status === 'connected' && network === 'testnet') return 'Connected · Testnet verified';
    if (status === 'connected' && network) return 'Wrong network';
    return status[0].toUpperCase() + status.slice(1);
  }),
  refreshWalletBalance: vi.fn(),
  privacyTokenReadErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : 'Wallet request failed',
  ),
  sendBeldexTransaction: vi.fn(),
  subscribeWallet: vi.fn(() => () => {}),
  subscribeWalletProvider: vi.fn((listener: () => void) => {
    window.addEventListener('beldex:announceProvider', listener);
    return () => window.removeEventListener('beldex:announceProvider', listener);
  }),
  validateAmount: vi.fn(() => null),
  validateBeldexAddress: vi.fn(() => ({ valid: true, normalizedAddress: 'test-recipient' })),
  walletErrorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : 'Wallet request failed'),
}));

const qrMocks = vi.hoisted(() => ({
  generateAddressQr: vi.fn((address: string) => Promise.resolve(`qr-for:${address}`)),
}));

vi.mock('./lib/beldexAdapter', () => walletAdapterMocks);
vi.mock('./lib/receiveQr', () => qrMocks);

const connectedState = {
  status: 'connected' as const,
  address: 'bxTestReceivingAddress',
  network: 'testnet',
  totalBalance: '2.5',
  unlockedBalance: '1.25',
  approximate: false,
};

describe('VeilPay application flows', () => {
  beforeEach(() => {
    window.localStorage.clear();
    walletAdapterMocks.detectWallet.mockClear();
    walletAdapterMocks.detectWallet.mockResolvedValue({
      status: 'not_detected',
      error: 'Beldex Wallet was not detected.',
    });
    walletAdapterMocks.connectWallet.mockResolvedValue(connectedState);
    walletAdapterMocks.disconnectWallet.mockResolvedValue({
      status: 'disconnected',
      error: 'Wallet disconnected.',
    });
    walletAdapterMocks.getPrivacyTokenBalances.mockReset();
    walletAdapterMocks.getPrivacyTokenBalances.mockResolvedValue({ tokens: [], height: 0 });
    walletAdapterMocks.getPrivacyTokenBalance.mockReset();
    walletAdapterMocks.getPrivacyTokenBalance.mockResolvedValue({
      tokenId: 'token123',
      status: 'confirmed',
      total: 250n,
      unlocked: 200n,
      locked: 50n,
      height: 42,
      ticker: 'TEST',
      decimalPoint: 2,
    });
    walletAdapterMocks.getPrivacyTokenInfo.mockReset();
    walletAdapterMocks.getPrivacyTokenInfo.mockResolvedValue({
      tokenId: 'token123',
      ticker: 'TEST',
      name: 'Test Token',
      owner: 'wallet-returned-owner',
      metaInfo: '',
      currentSupply: '1000',
      totalMaxSupply: '10000',
      decimalPoint: 2,
    });
    walletAdapterMocks.getBeldexOperationStatus.mockReset().mockResolvedValue({
      status: 'executing',
      operationId: 'operation123',
    });
    walletAdapterMocks.refreshWalletBalance.mockResolvedValue(connectedState);
    walletAdapterMocks.sendBeldexTransaction.mockReset();
    walletAdapterMocks.sendBeldexTransaction.mockResolvedValue({
      status: 'submitted',
      txHash: 'wallet-returned-transaction-id',
      fee: '0.001',
    });
    walletAdapterMocks.createIdempotencyKey.mockReturnValue('test-idempotency-key-123');
    walletAdapterMocks.fitsAmount.mockReturnValue(null);
    walletAdapterMocks.validateAmount.mockReturnValue(null);
    walletAdapterMocks.validateBeldexAddress.mockReturnValue({
      valid: true,
      normalizedAddress: 'test-recipient',
    });
    qrMocks.generateAddressQr.mockClear();
  });

  it('renders the exact main navigation order without a Connect nav item', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'VeilPay' })).toBeInTheDocument();
    });
    const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    expect(navigation.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Home',
      'Send',
      'Receive',
      'Wallet',
      'Activity',
      'Settings',
    ]);
    expect(navigation.queryByRole('button', { name: 'Swap', exact: true })).not.toBeInTheDocument();
    expect(navigation.queryByRole('button', { name: 'Connect', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect', exact: true })).toBeInTheDocument();
    await screen.findByText('Wallet not detected');

    expect(screen.getByText('No payments sent from VeilPay in this session yet. Your wallet history remains available in the Beldex Wallet.')).toBeInTheDocument();
    expect(screen.queryByText('Sent to wallet demo')).not.toBeInTheDocument();
  });

  it('keeps the user-focused wallet token scanner but removes manual token inspection', async () => {
    render(<App />);
    await screen.findByText('Wallet not detected');
    expect(screen.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('heading', { name: 'Swap' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));
    expect(screen.getByRole('button', { name: 'Wallet', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('View your BDX balance and token holdings reported by your wallet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Privacy Token holdings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Privacy Token lookup/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Privacy Token ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read wallet token balances' })).toBeDisabled();
    expect(walletAdapterMocks.sendBeldexTransaction).not.toHaveBeenCalled();
    expect(walletAdapterMocks.getPrivacyTokenInfo).not.toHaveBeenCalled();
    expect(walletAdapterMocks.getPrivacyTokenBalance).not.toHaveBeenCalled();
  });

  it('keeps Privacy Token reads disabled until a Testnet wallet is connected', async () => {
    render(<App />);
    await screen.findByText('Wallet not detected');
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));
    expect(screen.getByRole('button', { name: 'Read wallet token balances' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Read token data/ })).not.toBeInTheDocument();
  });

  it('flags a connected wallet on the wrong network and disables token reads', async () => {
    walletAdapterMocks.detectWallet.mockResolvedValue({ ...connectedState, network: 'mainnet' });
    render(<App />);
    await screen.findByText('Wrong network');
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));
    expect(screen.getByText('Beldex Mainnet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read wallet token balances' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Read token data/ })).not.toBeInTheDocument();
  });

  it('reads and distinguishes connected Testnet wallet token balances', async () => {
    walletAdapterMocks.detectWallet.mockResolvedValue(connectedState);
    walletAdapterMocks.getPrivacyTokenBalances.mockResolvedValue({
      tokens: [
        {
          tokenId: 'token123',
          status: 'confirmed',
          total: 250n,
          unlocked: 200n,
          locked: 50n,
          ticker: 'TEST',
          decimalPoint: 2,
        },
        {
          tokenId: 'unknown456',
          status: 'unknown',
          total: 0n,
          unlocked: 0n,
          locked: 0n,
        },
      ],
      height: 42,
    });
    render(<App />);
    await screen.findByText('Connected · Testnet verified');
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));

    const readButton = screen.getByRole('button', { name: 'Read wallet token balances' });
    expect(readButton).toBeEnabled();
    fireEvent.click(readButton);

    expect(await screen.findByText('TEST')).toBeInTheDocument();
    expect(screen.getByText('2.5 total · 2 available · 0.5 locked')).toBeInTheDocument();
    expect(screen.getByText('A token balance is still being verified.')).toBeInTheDocument();
    expect(screen.queryByText(/Token ID|scan height|wallet-reported confirmed/i)).not.toBeInTheDocument();
    expect(walletAdapterMocks.sendBeldexTransaction).not.toHaveBeenCalled();
  });

  it('surfaces wallet token-read failures and rejects malformed balance snapshots', async () => {
    walletAdapterMocks.detectWallet.mockResolvedValue(connectedState);
    walletAdapterMocks.getPrivacyTokenBalances
      .mockRejectedValueOnce(new Error('Token balance service unavailable'))
      .mockResolvedValueOnce({
        tokens: [
          {
            tokenId: 'token123',
            status: 'confirmed',
            total: 250n,
            unlocked: 200n,
            locked: 40n,
            ticker: 'TEST',
            decimalPoint: 2,
          },
        ],
        height: 42,
      });
    render(<App />);
    await screen.findByText('Connected · Testnet verified');
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Read wallet token balances' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Token balance service unavailable');

    fireEvent.click(screen.getByRole('button', { name: 'Read wallet token balances' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The wallet returned an incomplete or inconsistent token balance response.',
    );
    expect(screen.queryByText('Wallet scan height: 42')).not.toBeInTheDocument();
  });

  it('orders navigation consistently and keeps Activity and route switching functional', async () => {
    render(<App />);
    await screen.findByText('Wallet not detected');
    const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    expect(navigation.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Home',
      'Send',
      'Receive',
      'Wallet',
      'Activity',
      'Settings',
    ]);
    expect(navigation.queryByRole('button', { name: 'Connect', exact: true })).not.toBeInTheDocument();

    fireEvent.click(navigation.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('heading', { name: 'Activity', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activity', level: 3 })).toBeInTheDocument();
    expect(navigation.getByRole('button', { name: 'Activity' })).toHaveClass('active');

    fireEvent.click(navigation.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('heading', { name: 'Send BDX', level: 3 })).toBeInTheDocument();
    expect(navigation.getByRole('button', { name: 'Send' })).toHaveClass('active');
  });

  it('opens the existing wallet connection flow from the header action', async () => {
    render(<App />);
    await screen.findByText('Wallet not detected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));

    expect(screen.getByRole('heading', { name: 'Connect Beldex Wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for Beldex Wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect', exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('Wallet not detected', { selector: '.status-badge' })).toBeInTheDocument();
  });

  it('keeps the wallet connection controls without a diagnostics panel', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));

    expect(await screen.findByRole('heading', { name: 'Connect Beldex Wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for Beldex Wallet' })).toBeInTheDocument();
    expect(screen.queryByText(/Wallet Diagnostics|diagnostic-origin|SDK bridge status/i)).not.toBeInTheDocument();
  });

  it('connects and disconnects through the existing Beldex wallet actions', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check for Beldex Wallet' }));

    expect(await screen.findByText('Connected · Testnet verified', { selector: '.status-badge' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(walletAdapterMocks.disconnectWallet).toHaveBeenCalledOnce();
    expect(await screen.findByText('Disconnected', { selector: '.status-badge' })).toBeInTheDocument();
  });

  it('retries SDK detection when the Beldex extension announces after initial detection', async () => {
    walletAdapterMocks.detectWallet
      .mockResolvedValueOnce({
        status: 'not_detected',
        error: 'Beldex Wallet was not detected.',
      })
      .mockResolvedValueOnce({
        status: 'disconnected',
        error: 'Beldex Wallet detected. Connect to continue.',
      });
    render(<App />);
    await screen.findByText('Wallet not detected');

    window.dispatchEvent(new Event('beldex:announceProvider'));

    expect(await screen.findByText('Disconnected', { selector: '.status-badge' })).toBeInTheDocument();
    expect(walletAdapterMocks.detectWallet).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    expect(screen.getByText('Beldex Wallet detected. Connect to continue.')).toBeInTheDocument();
  });

  it('does not render a QR code when the extension is missing or the wallet is disconnected', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Receive', exact: true }));

    expect(await screen.findByText('Beldex Wallet was not detected.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR code for/ })).not.toBeInTheDocument();
    expect(qrMocks.generateAddressQr).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByRole('heading', { name: 'Connect Beldex Wallet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for Beldex Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: /QR code for/ })).not.toBeInTheDocument();
    });
  });

  it('encodes, displays, downloads, and copies the exact connected receive address', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Receive', exact: true }));

    await screen.findByRole('img', { name: `QR code for ${connectedState.address}` });
    expect(qrMocks.generateAddressQr).toHaveBeenCalledWith(connectedState.address);
    expect(screen.getByLabelText('Receiving address')).toHaveTextContent(connectedState.address);
    expect(screen.getByRole('link', { name: 'Download QR' })).toHaveAttribute(
      'href',
      `qr-for:${connectedState.address}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(connectedState.address));
    expect(screen.getByRole('status')).toHaveTextContent('Address copied.');
  });

  it('updates receive address and QR when the connected wallet account changes', async () => {
    walletAdapterMocks.connectWallet
      .mockResolvedValueOnce(connectedState)
      .mockResolvedValueOnce({ ...connectedState, address: 'bxChangedReceivingAddress' });
    walletAdapterMocks.disconnectWallet.mockResolvedValue({ status: 'disconnected' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('button', { name: 'Connect Wallet' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Receive', exact: true }));

    await screen.findByRole('img', { name: 'QR code for bxChangedReceivingAddress' });
    expect(screen.getByLabelText('Receiving address')).toHaveTextContent('bxChangedReceivingAddress');
    expect(qrMocks.generateAddressQr).toHaveBeenLastCalledWith('bxChangedReceivingAddress');
  });

  it('previews sends, prevents duplicate approval requests, and records only wallet-returned submissions', async () => {
    let resolveSend: ((value: { status: 'submitted'; txHash: string; fee: string }) => void) | undefined;
    const sendPromise = new Promise<{ status: 'submitted'; txHash: string; fee: string }>((resolve) => {
      resolveSend = resolve;
    });
    walletAdapterMocks.sendBeldexTransaction.mockReturnValue(sendPromise);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Send', exact: true }));

    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'test-recipient' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review payment' }));
    expect(screen.getByText('0.25 BDX')).toBeInTheDocument();
    const approveButton = screen.getByRole('button', { name: 'Approve in wallet' });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    expect(walletAdapterMocks.sendBeldexTransaction).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Waiting for wallet…' })).toBeDisabled();

    await act(async () => {
      resolveSend?.({
        status: 'submitted',
        txHash: 'wallet-returned-transaction-id',
        fee: '0.001',
      });
      await sendPromise;
    });
    expect(await screen.findByText(/Submission is not chain confirmation/)).toBeInTheDocument();
    expect(screen.getByText(/wallet-returned-transaction-id/)).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.queryByText('confirmed')).not.toBeInTheDocument();
  });

  it('keeps an unresolved send tied to the same payment key and reports provider rejection', async () => {
    walletAdapterMocks.sendBeldexTransaction
      .mockResolvedValueOnce({ status: 'unresolved', idempotencyKey: 'test-idempotency-key-123' })
      .mockRejectedValueOnce(new Error('Wallet approval was rejected.'));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'test-recipient' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve in wallet' }));

    const retry = await screen.findByRole('button', { name: 'Review and retry safely (same payment)' });
    expect(screen.getByText(/Do not start a new payment/)).toBeInTheDocument();
    fireEvent.click(retry);
    await screen.findByText('Wallet approval was rejected.');
    expect(walletAdapterMocks.sendBeldexTransaction).toHaveBeenNthCalledWith(
      1,
      'test-recipient',
      '0.25',
      'test-idempotency-key-123',
      connectedState.address,
    );
    expect(walletAdapterMocks.sendBeldexTransaction).toHaveBeenNthCalledWith(
      2,
      'test-recipient',
      '0.25',
      'test-idempotency-key-123',
      connectedState.address,
    );
  });

  it('shows a real balance loading state and keeps Send disabled until it is available', async () => {
    walletAdapterMocks.connectWallet.mockResolvedValue({
      ...connectedState,
      totalBalance: undefined,
      unlockedBalance: undefined,
      balanceLoading: true,
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));

    expect(screen.getAllByText('Loading…')).toHaveLength(2);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Send', exact: true }),
    );
    expect(screen.getByRole('button', { name: 'Review payment' })).toBeDisabled();
  });

  it('shows balance read failures as unavailable rather than a fallback value', async () => {
    walletAdapterMocks.connectWallet.mockResolvedValue({
      ...connectedState,
      totalBalance: undefined,
      unlockedBalance: undefined,
      balanceLoading: false,
      balanceError: 'Balance RPC unavailable',
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Wallet', exact: true }));

    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.getByText('Balance RPC unavailable')).toBeInTheDocument();
  });

  it.each(['mainnet', 'unknown', ''])('blocks BDX review on %s networks in the UI', async (network) => {
    walletAdapterMocks.connectWallet.mockResolvedValue({
      ...connectedState,
      network,
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));

    expect(screen.getByRole('button', { name: 'Review payment' })).toBeDisabled();
    expect(walletAdapterMocks.sendBeldexTransaction).not.toHaveBeenCalled();
  });

  it('restores a pending operation after reload and queries status without resubmitting', async () => {
    window.localStorage.setItem('veilpay.pending-bdx-operation.v1', JSON.stringify({
      recipient: 'test-recipient',
      amount: '0.25',
      idempotencyKey: 'test-idempotency-key-123',
      walletAddress: connectedState.address,
      network: 'testnet',
      outcome: 'submitted',
      operationId: 'operation123',
    }));
    walletAdapterMocks.detectWallet.mockResolvedValue(connectedState);
    walletAdapterMocks.getBeldexOperationStatus.mockResolvedValue({ status: 'unknown' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));

    await screen.findByText(/wallet reports unknown/i);
    expect(walletAdapterMocks.getBeldexOperationStatus).toHaveBeenCalledWith(
      'operation123',
      connectedState.address,
    );
    expect(walletAdapterMocks.sendBeldexTransaction).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('veilpay.pending-bdx-operation.v1')).toContain('"operationStatus":"unknown"');
  });

  it('does not expose a restored operation to a different wallet account', async () => {
    window.localStorage.setItem('veilpay.pending-bdx-operation.v1', JSON.stringify({
      recipient: 'test-recipient',
      amount: '0.25',
      idempotencyKey: 'test-idempotency-key-123',
      walletAddress: 'bxDifferentAccount',
      network: 'testnet',
      outcome: 'submitted',
      operationId: 'operation123',
    }));
    walletAdapterMocks.detectWallet.mockResolvedValue(connectedState);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));

    expect(await screen.findByText(/connect the originating wallet on testnet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check operation status' })).toBeDisabled();
    expect(walletAdapterMocks.getBeldexOperationStatus).not.toHaveBeenCalled();
    expect(walletAdapterMocks.sendBeldexTransaction).not.toHaveBeenCalled();
  });

  it('does not query a restored Testnet operation while connected on Mainnet', async () => {
    window.localStorage.setItem('veilpay.pending-bdx-operation.v1', JSON.stringify({
      recipient: 'test-recipient',
      amount: '0.25',
      idempotencyKey: 'test-idempotency-key-123',
      walletAddress: connectedState.address,
      network: 'testnet',
      outcome: 'submitted',
      operationId: 'operation123',
    }));
    walletAdapterMocks.detectWallet.mockResolvedValue({ ...connectedState, network: 'mainnet' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));

    expect(await screen.findByText(/connect the originating wallet on testnet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check operation status' })).toBeDisabled();
    expect(walletAdapterMocks.getBeldexOperationStatus).not.toHaveBeenCalled();
    expect(walletAdapterMocks.sendBeldexTransaction).not.toHaveBeenCalled();
  });

  it('explains network controls in settings and avoids claiming key storage', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wallet' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings', exact: true }));
    expect(screen.getByText('Network: Beldex Testnet')).toBeInTheDocument();
    expect(screen.getByText(/never asks for your private key or recovery phrase/)).toBeInTheDocument();
  });
});
