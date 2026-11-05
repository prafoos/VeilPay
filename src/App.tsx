import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectWallet as connectBeldexWallet,
  createIdempotencyKey,
  detectWallet,
  disconnectWallet as disconnectBeldexWallet,
  fitsAmount,
  getPrivacyTokenBalances,
  getBeldexOperationStatus,
  getWalletStatusLabel,
  privacyTokenReadErrorMessage,
  refreshWalletBalance,
  sendBeldexTransaction,
  subscribeWallet,
  subscribeWalletProvider,
  validateAmount,
  validateBeldexAddress,
  walletErrorMessage,
  type WalletConnectionState,
} from './lib/beldexAdapter';
import {
  loadPendingPayment,
  removePendingPayment,
  savePendingPayment,
  type PendingPayment,
} from './lib/pendingPaymentStorage';
import { generateAddressQr } from './lib/receiveQr';

const navItems: Array<{ key: Route; label: string }> = [
  { key: 'home', label: 'Home' },
  { key: 'send', label: 'Send' },
  { key: 'receive', label: 'Receive' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'activity', label: 'Activity' },
  { key: 'settings', label: 'Settings' },
];

type Route = 'send' | 'receive' | 'home' | 'connect' | 'wallet' | 'activity' | 'settings';

const routeTitles: Record<Route, string> = {
  home: 'Home',
  connect: 'Connect wallet',
  wallet: 'Wallet overview',
  send: 'Send BDX',
  receive: 'Receive BDX',
  activity: 'Activity',
  settings: 'Settings',
};

const routeDescriptions: Record<Route, string> = {
  home: 'A simple way to send and receive BDX using your Beldex Wallet.',
  connect: 'Connect or manage the Beldex Wallet that controls your account.',
  wallet: 'View your BDX balance and token holdings reported by your wallet.',
  send: 'Review a BDX payment before approving it in your wallet.',
  receive: 'Share your Beldex address to receive BDX.',
  activity: 'Review payments submitted from VeilPay during this session.',
  settings: 'Your wallet controls network selection and transaction approval.',
};

type ActivityItem = {
  id: string;
  recipient: string;
  amount: string;
  fee: string;
};

function formatAtomicAmount(amountAtomic: string, decimals: number): string {
  const amount = BigInt(amountAtomic);
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fractional = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function formatNetworkLabel(network: string | undefined): string {
  if (network === 'testnet') return 'Beldex Testnet';
  if (network === 'mainnet') return 'Beldex Mainnet';
  return 'Network not verified';
}

function App() {
  const [route, setRoute] = useState<Route>('home');
  const [walletState, setWalletState] = useState<WalletConnectionState>({ status: 'detecting' });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [initialPendingPayment] = useState(loadPendingPayment);
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(initialPendingPayment.payment);
  const [pendingRecoveryError, setPendingRecoveryError] = useState(initialPendingPayment.error ?? '');
  const [isCheckingOperation, setIsCheckingOperation] = useState(false);
  const [privacyTokenBalanceRead, setPrivacyTokenBalanceRead] = useState<{
    requestId: number;
    walletAddress: string;
    network: string;
    walletStatus: WalletConnectionState['status'];
    balances?: Awaited<ReturnType<typeof getPrivacyTokenBalances>>;
    error?: string;
    loading: boolean;
  } | null>(null);
  const [formError, setFormError] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [lastAction, setLastAction] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<{ address: string; message: string } | null>(null);
  const [qrResult, setQrResult] = useState<{ address: string; dataUrl?: string; error?: string } | null>(null);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const sendInFlight = useRef(false);
  const checkedOperationIds = useRef(new Set<string>());
  const privacyTokenBalanceRequest = useRef(0);
  const walletStateRef = useRef(walletState);
  const updateWalletState = useCallback((state: WalletConnectionState) => {
    walletStateRef.current = state;
    privacyTokenBalanceRequest.current += 1;
    setPrivacyTokenBalanceRead(null);
    setWalletState(state);
  }, []);
  const walletAddress = walletState.address ?? '';
  const network = walletState.network ?? '';
  const currentPrivacyTokenBalanceRead =
    privacyTokenBalanceRead?.walletAddress === walletAddress &&
    privacyTokenBalanceRead.network === network &&
    privacyTokenBalanceRead.walletStatus === walletState.status
      ? privacyTokenBalanceRead
      : null;
  const copyMessage = copyFeedback?.address === walletAddress ? copyFeedback.message : '';
  const qrMatchesAddress = qrResult?.address === walletAddress;
  const qrDataUrl = qrMatchesAddress ? qrResult.dataUrl ?? '' : '';
  const qrError = qrMatchesAddress ? qrResult.error ?? '' : '';
  useEffect(() => {
    const unsubscribe = subscribeWallet(updateWalletState);
    let active = true;
    const retryDetection = () => {
      const { status } = walletStateRef.current;
      if (status !== 'detecting' && status !== 'not_detected' && status !== 'unsupported' && status !== 'error') {
        return;
      }
      void detectWallet().then((state) => {
        if (active) {
          updateWalletState(state);
        }
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        retryDetection();
      }
    };
    const unsubscribeProvider = subscribeWalletProvider(retryDetection);
    window.addEventListener('focus', retryDetection);
    document.addEventListener('visibilitychange', onVisibilityChange);
    retryDetection();
    return () => {
      active = false;
      unsubscribe();
      unsubscribeProvider();
      window.removeEventListener('focus', retryDetection);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [updateWalletState]);
  useEffect(() => {
    return () => {
      privacyTokenBalanceRequest.current += 1;
    };
  }, []);

  const readPrivacyTokenBalances = useCallback(async () => {
    const requestId = ++privacyTokenBalanceRequest.current;
    const walletContext = {
      requestId,
      walletAddress,
      network,
      walletStatus: walletState.status,
    };
    setPrivacyTokenBalanceRead({ ...walletContext, loading: true });
    try {
      const result = await getPrivacyTokenBalances();
      const validResult = Number.isSafeInteger(result.height) &&
        result.height >= 0 &&
        Array.isArray(result.tokens) &&
        result.tokens.every((token) =>
          typeof token.tokenId === 'string' &&
          /^[A-Za-z0-9]{1,64}$/.test(token.tokenId) &&
          ['confirmed', 'not_found', 'unknown'].includes(token.status) &&
          (token.status !== 'confirmed' ||
            (typeof token.ticker === 'string' &&
              token.ticker.trim().length > 0 &&
              Number.isInteger(token.decimalPoint) &&
              token.decimalPoint! >= 0 &&
              token.decimalPoint! <= 18 &&
              typeof token.total === 'bigint' &&
              typeof token.unlocked === 'bigint' &&
              typeof token.locked === 'bigint' &&
              token.total >= 0n &&
              token.unlocked >= 0n &&
              token.locked >= 0n &&
              token.total === token.unlocked + token.locked)),
        );
      if (!validResult) {
        throw new Error('The wallet returned an incomplete or inconsistent token balance response.');
      }
      if (requestId === privacyTokenBalanceRequest.current) {
        setPrivacyTokenBalanceRead({ ...walletContext, balances: result, loading: false });
      }
    } catch (error) {
      if (requestId === privacyTokenBalanceRequest.current) {
        setPrivacyTokenBalanceRead({
          ...walletContext,
          error: privacyTokenReadErrorMessage(error),
          loading: false,
        });
      }
    }
  }, [network, walletAddress, walletState.status]);

  useEffect(() => {
    if (!walletAddress) {
      return;
    }

    let cancelled = false;
    void generateAddressQr(walletAddress).then(
      (dataUrl) => {
        if (!cancelled) {
          setQrResult({ address: walletAddress, dataUrl });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setQrResult({
            address: walletAddress,
            error: error instanceof Error ? error.message : 'Unable to generate the address QR code.',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  const loadWalletState = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const state = walletState.status === 'connected' || walletState.status === 'locked'
        ? await refreshWalletBalance()
        : await detectWallet();
      updateWalletState(state);
    } finally {
      setIsRefreshing(false);
    }
  }, [updateWalletState, walletState.status]);

  async function handleConnectWallet() {
    setLastAction('');
    updateWalletState(await connectBeldexWallet());
  }

  const handleCopyAddress = useCallback(async () => {
    if (!walletAddress) {
      setCopyFeedback({ address: '', message: 'No connected address to copy.' });
      return;
    }

    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopyFeedback({ address: walletAddress, message: 'Address copied.' });
      setLastAction('Address copied to clipboard.');
    } catch {
      setCopyFeedback({ address: walletAddress, message: 'Copy failed.' });
      setLastAction('Copy failed; copy the address manually.');
    }
  }, [walletAddress]);

  async function disconnectWallet() {
    const state = await disconnectBeldexWallet();
    updateWalletState(state);
    if (state.status === 'disconnected') {
      setLastAction('Wallet disconnected.');
      setReviewOpen(false);
    }
  }

  function handleSendChange(nextRecipient: string, nextAmount: string) {
    if (pendingPayment) {
      return;
    }
    setRecipient(nextRecipient);
    setAmount(nextAmount);
    setFormError('');
    setReviewError('');
  }

  const handleReview = useCallback(() => {
    if (walletState.status !== 'connected') {
      setFormError('Connect the Beldex Wallet before sending.');
      return;
    }
    if (network !== 'testnet' || !walletState.address) {
      setFormError('A connected Beldex Testnet wallet is required before reviewing a payment.');
      return;
    }
    const addressCheck = validateBeldexAddress(recipient, 'testnet');
    const amountCheck = validateAmount(amount);
    const balanceCheck = walletState.balanceLoading
      ? 'Wait for the wallet balance to finish loading before sending.'
      : fitsAmount(amount, walletState.unlockedBalance);

    if (!addressCheck.valid) {
      setFormError(addressCheck.reason ?? 'Invalid recipient address.');
      return;
    }

    if (amountCheck) {
      setFormError(amountCheck);
      return;
    }

    if (balanceCheck) {
      setFormError(balanceCheck);
      return;
    }

    setFormError('');
    setReviewOpen(true);
  }, [amount, network, recipient, walletState.address, walletState.balanceLoading, walletState.status, walletState.unlockedBalance]);

  const approveFromWallet = useCallback(async () => {
    if (sendInFlight.current) {
      return;
    }

    if (
      walletState.status !== 'connected' ||
      network !== 'testnet' ||
      !walletState.address ||
      (pendingPayment !== null &&
        (pendingPayment.walletAddress !== walletState.address || pendingPayment.network !== network))
    ) {
      setReviewError('Reconnect the originating Beldex Testnet wallet before continuing this payment.');
      return;
    }

    let payment: PendingPayment;
    try {
      payment = pendingPayment ?? {
        recipient,
        amount,
        idempotencyKey: createIdempotencyKey(),
        walletAddress: walletState.address,
        network: 'testnet',
        outcome: 'unresolved',
      };
    } catch (error) {
      setReviewError(walletErrorMessage(error));
      return;
    }
    const addressCheck = validateBeldexAddress(payment.recipient, 'testnet');
    const amountCheck = validateAmount(payment.amount);
    const balanceCheck = pendingPayment
      ? null
      : walletState.balanceLoading
        ? 'Wait for the wallet balance to finish loading before sending.'
        : fitsAmount(payment.amount, walletState.unlockedBalance);
    if (!addressCheck.valid || amountCheck || balanceCheck) {
      setReviewError(
        addressCheck.reason ?? amountCheck ?? balanceCheck ?? 'Please correct the form before approving.',
      );
      return;
    }

    const storageError = savePendingPayment(payment);
    if (storageError) {
      setPendingRecoveryError(storageError);
      setReviewError(storageError);
      return;
    }
    setPendingRecoveryError('');
    sendInFlight.current = true;
    setIsSending(true);
    setPendingPayment(payment);
    setReviewError('');
    try {
      const result = await sendBeldexTransaction(
        addressCheck.normalizedAddress ?? payment.recipient,
        payment.amount,
        payment.idempotencyKey,
        payment.walletAddress,
      );
      if (result.status === 'unresolved') {
        const unresolvedPayment: PendingPayment = { ...payment, outcome: 'unresolved' };
        const unresolvedStorageError = savePendingPayment(unresolvedPayment);
        setPendingPayment(unresolvedPayment);
        if (unresolvedStorageError) {
          setPendingRecoveryError(unresolvedStorageError);
        }
        setReviewError(
          'The outcome is unresolved. Do not start a new payment. Review this payment before choosing any recovery action.',
        );
        return;
      }

      const submittedPayment: PendingPayment = {
        ...payment,
        outcome: 'submitted',
        operationId: result.operationId,
        operationStatus: result.operationId ? 'executing' : 'unavailable',
      };
      const submittedStorageError = savePendingPayment(submittedPayment);
      setPendingPayment(submittedPayment);
      if (submittedStorageError) {
        setPendingRecoveryError(submittedStorageError);
      }
      setActivityItems((items) => [
        {
          id: result.txHash,
          recipient: payment.recipient,
          amount: payment.amount,
          fee: result.fee,
        },
        ...items,
      ]);
      setLastAction(
        `Wallet reported the transaction submitted. Fee: ${result.fee} BDX. Submission is not chain confirmation.`,
      );
      setReviewOpen(false);
      updateWalletState(await refreshWalletBalance());
    } catch (error) {
      setReviewError(walletErrorMessage(error));
    } finally {
      sendInFlight.current = false;
      setIsSending(false);
    }
  }, [
    amount,
    network,
    pendingPayment,
    recipient,
    updateWalletState,
    walletState.balanceLoading,
    walletState.address,
    walletState.status,
    walletState.unlockedBalance,
  ]);

  const checkPendingOperation = useCallback(async (payment: PendingPayment) => {
    if (
      walletState.status !== 'connected' ||
      walletState.address !== payment.walletAddress ||
      network !== payment.network
    ) {
      setReviewError('Connect the originating wallet on its original network to check this operation.');
      return;
    }
    if (!payment.operationId) {
      setReviewError(
        'The wallet did not provide an operation ID. The status API cannot verify this outcome; review it in the originating wallet.',
      );
      return;
    }

    setIsCheckingOperation(true);
    setReviewError('');
    try {
      const operationStatus = await getBeldexOperationStatus(payment.operationId, payment.walletAddress);
      const updatedPayment: PendingPayment = { ...payment, operationStatus: operationStatus.status };
      setPendingPayment(updatedPayment);
      setPendingRecoveryError(savePendingPayment(updatedPayment) ?? '');
      if (operationStatus.status === 'unknown') {
        setReviewError(
          'The wallet returned unknown. This does not prove the transaction was not sent; review the originating wallet before taking further action.',
        );
      }
    } catch (error) {
      const updatedPayment: PendingPayment = { ...payment, operationStatus: 'unavailable' };
      setPendingPayment(updatedPayment);
      setPendingRecoveryError(savePendingPayment(updatedPayment) ?? '');
      setReviewError(walletErrorMessage(error));
    } finally {
      setIsCheckingOperation(false);
    }
  }, [network, walletState.address, walletState.status]);

  useEffect(() => {
    if (
      !pendingPayment?.operationId ||
      walletState.status !== 'connected' ||
      walletState.address !== pendingPayment.walletAddress ||
      network !== pendingPayment.network ||
      checkedOperationIds.current.has(pendingPayment.operationId)
    ) {
      return;
    }
    checkedOperationIds.current.add(pendingPayment.operationId);
    void checkPendingOperation(pendingPayment);
  }, [checkPendingOperation, network, pendingPayment, walletState.address, walletState.status]);

  const dismissResolvedOperation = useCallback(() => {
    if (pendingPayment?.operationStatus !== 'confirmed' && pendingPayment?.operationStatus !== 'failed') {
      return;
    }
    const storageError = removePendingPayment();
    if (storageError) {
      setPendingRecoveryError(storageError);
      return;
    }
    setPendingPayment(null);
    setReviewError('');
    setPendingRecoveryError('');
  }, [pendingPayment]);

  const acknowledgeRecoveryAfterWalletReview = useCallback(() => {
    if (
      !pendingPayment ||
      walletState.status !== 'connected' ||
      walletState.address !== pendingPayment.walletAddress ||
      network !== pendingPayment.network ||
      (pendingPayment.operationStatus !== 'unknown' &&
        pendingPayment.operationStatus !== 'unavailable' &&
        !(pendingPayment.outcome === 'unresolved' && !pendingPayment.operationId))
    ) {
      return;
    }
    const storageError = removePendingPayment();
    if (storageError) {
      setPendingRecoveryError(storageError);
      return;
    }
    setPendingPayment(null);
    setReviewError('');
    setPendingRecoveryError('');
  }, [network, pendingPayment, walletState.address, walletState.status]);

  const activityList = (
    <div className="activity-list">
      {activityItems.length === 0 ? (
        <div className="empty-state">
          <p>No payments sent from VeilPay in this session yet. Your wallet history remains available in the Beldex Wallet.</p>
        </div>
      ) : (
        activityItems.map((item) => (
          <div key={item.id} className="activity-row">
            <div className="activity-copy">
              <strong>BDX sent from VeilPay</strong>
              <div className="activity-description">To {item.recipient}</div>
              <div className="activity-description">Transaction ID: {item.id}</div>
              <div className="activity-description">Network fee: {item.fee} BDX</div>
            </div>
            <div className="activity-meta">
              <span className="activity-amount">-{item.amount} BDX</span>
              <span className="status-pill submitted">Submitted</span>
            </div>
          </div>
        ))
      )}
    </div>
  );

  const privacyTokenReadOnlyPanel = (
    <div className="wallet-token-panels">
      <section className="read-only-section" aria-labelledby="wallet-token-balances-heading">
        <div className="section-title">
          <h3 id="wallet-token-balances-heading">Privacy Token holdings</h3>
          <span className="badge badge-muted">Read only</span>
        </div>
        <p>View token balances reported by your connected Beldex Testnet wallet.</p>
        <button
          className="button secondary"
          type="button"
          onClick={() => void readPrivacyTokenBalances()}
          disabled={
            walletState.status !== 'connected' ||
            network !== 'testnet' ||
            currentPrivacyTokenBalanceRead?.loading === true
          }
        >
          {currentPrivacyTokenBalanceRead?.loading
            ? 'Reading wallet balances…'
            : 'Read wallet token balances'}
        </button>
        {currentPrivacyTokenBalanceRead?.error ? (
          <p className="error-text" role="alert">{currentPrivacyTokenBalanceRead.error}</p>
        ) : null}
        {currentPrivacyTokenBalanceRead?.balances ? (
          <div className="token-read-results" aria-live="polite">
            {currentPrivacyTokenBalanceRead.balances.tokens.length === 0 ? (
              <p>No token balances were reported by the wallet.</p>
            ) : (
              <ul>
                {currentPrivacyTokenBalanceRead.balances.tokens.map((token, index) => (
                  <li key={`${token.tokenId}-${index}`}>
                    {token.status === 'confirmed' &&
                    typeof token.ticker === 'string' &&
                    token.ticker.trim().length > 0 &&
                    Number.isInteger(token.decimalPoint) &&
                    token.decimalPoint! >= 0 &&
                    token.decimalPoint! <= 18 &&
                    typeof token.total === 'bigint' &&
                    typeof token.unlocked === 'bigint' &&
                    typeof token.locked === 'bigint' ? (
                      <>
                        <strong>{token.ticker}</strong>
                        <span>
                          {formatAtomicAmount(token.total.toString(), token.decimalPoint!)} total ·{' '}
                          {formatAtomicAmount(token.unlocked.toString(), token.decimalPoint!)} available ·{' '}
                          {formatAtomicAmount(token.locked.toString(), token.decimalPoint!)} locked
                        </span>
                      </>
                    ) : (
                      <span>
                        {token.status === 'unknown'
                          ? 'A token balance is still being verified.'
                          : 'A token balance could not be found.'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );

  const currentRouteContent = (() => {
    const copyButton = walletAddress ? (
      <button className="button secondary tiny" type="button" onClick={handleCopyAddress}>
        {copyMessage === 'Address copied.' ? 'Copied' : 'Copy'}
      </button>
    ) : null;

    if (route === 'connect') {
      return (
        <>
          <div className="card route-card connect-screen">
            <div className="section-title">
              <h3>Connect Beldex Wallet</h3>
              <span className="badge">{getWalletStatusLabel(walletState.status, walletState.network)}</span>
            </div>

            <div className="wallet-card">
              <div className="wallet-id-row">
                <div className="wallet-id">{walletAddress || 'No wallet connected yet'}</div>
                {copyButton}
              </div>
              <div className="badge-row">
                <span className="badge">{formatNetworkLabel(network)}</span>
                <span className="badge">{getWalletStatusLabel(walletState.status, walletState.network)}</span>
              </div>

              {walletState.error ? (
                <div className="info-state">
                  <p>{walletState.error}</p>
                </div>
              ) : null}

              <div className="action-row">
                {walletState.status === 'connected' ? (
                  <button className="button danger" onClick={disconnectWallet}>Disconnect</button>
                ) : (
                  <button className="button primary" onClick={handleConnectWallet} disabled={walletState.status === 'connecting'}>
                    {walletState.status === 'connecting'
                      ? 'Waiting for approval…'
                      : walletState.status === 'locked'
                        ? 'Unlock and retry'
                        : walletState.status === 'not_detected'
                          ? 'Check for Beldex Wallet'
                          : walletState.status === 'unsupported'
                            ? 'Retry wallet detection'
                            : walletState.status === 'error'
                              ? 'Retry connection'
                              : 'Connect Wallet'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      );
    }

    if (route === 'wallet') {
      return (
        <div className="card route-card wallet-screen">
          <div className="section-title">
            <h3>Wallet Overview</h3>
            <button className="button secondary" onClick={loadWalletState} disabled={isRefreshing}>
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="wallet-card">
            <div className="wallet-id">{walletAddress || 'Not connected'}</div>
            <div className="badge-row">
              <span className="badge">{formatNetworkLabel(network)}</span>
              <span className="badge">{getWalletStatusLabel(walletState.status, walletState.network)}</span>
            </div>

            <div className="metric-grid">
              <div className="metric">
                <div className="metric-label">BDX balance</div>
                <div className="metric-value">
                  {walletState.balanceLoading
                    ? 'Loading…'
                    : walletState.totalBalance === undefined
                      ? 'Unavailable'
                      : `${walletState.totalBalance} BDX`}
                </div>
              </div>
              <div className="metric">
                <div className="metric-label">Unlocked</div>
                <div className="metric-value">
                  {walletState.balanceLoading
                    ? 'Loading…'
                    : walletState.unlockedBalance === undefined
                      ? 'Unavailable'
                      : `${walletState.unlockedBalance} BDX`}
                </div>
              </div>
            </div>
            {walletState.approximate ? (
              <div className="info-state" role="status"><p>The wallet marked this balance as approximate.</p></div>
            ) : null}
            {walletState.balanceError ? <p className="error-text">{walletState.balanceError}</p> : null}

            <div className="action-row">
              <button className="button primary" onClick={() => setRoute('send')}>Send</button>
              <button className="button ghost" onClick={() => setRoute('receive')}>Receive</button>
            </div>
          </div>
          {privacyTokenReadOnlyPanel}
        </div>
      );
    }

    if (route === 'send') {
      return (
        <div className="card route-card send-screen">
          <div className="section-title">
            <h3>Send BDX</h3>
            <span className="badge">
              {walletState.status !== 'connected'
                ? 'Wallet required'
                : walletState.balanceLoading
                  ? 'Loading balance…'
                  : walletState.unlockedBalance === undefined
                  ? 'Balance unavailable'
                  : 'Ready'}
            </span>
          </div>

          <div className="wallet-card send-card">
            <div className="field-group">
              <label className="field-label" htmlFor="recipient-address">Recipient</label>
              <input
                id="recipient-address"
                type="text"
                value={recipient}
                onChange={(event) => handleSendChange(event.target.value, amount)}
                placeholder="Paste Beldex address"
                className="form-input"
                disabled={Boolean(pendingPayment)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="send-amount">Amount</label>
              <input
                id="send-amount"
                type="text"
                value={amount}
                onChange={(event) => handleSendChange(recipient, event.target.value)}
                placeholder="0.00"
                className="form-input"
                disabled={Boolean(pendingPayment)}
              />
            </div>

            {formError ? <p className="error-text">{formError}</p> : null}

            <div className="action-row action-row-tight">
              <button
                className="button primary"
                onClick={handleReview}
                disabled={
                  walletState.status !== 'connected' ||
                  network !== 'testnet' ||
                  walletState.balanceLoading === true ||
                  walletState.unlockedBalance === undefined
                }
              >
                Review payment
              </button>
            </div>

            {pendingRecoveryError ? <p className="error-text" role="alert">{pendingRecoveryError}</p> : null}
            {reviewOpen || pendingPayment ? (
              <div className="review-card">
                <div className="metric-grid review-grid">
                  <div className="metric review-metric">
                    <div className="metric-label">To</div>
                    <div className="metric-value review-value">{pendingPayment?.recipient ?? recipient}</div>
                  </div>
                  <div className="metric review-metric">
                    <div className="metric-label">Amount</div>
                    <div className="metric-value review-value">{pendingPayment?.amount ?? amount} BDX</div>
                  </div>
                </div>
                <p className="activity-description">
                  The Beldex Wallet calculates and displays the network fee in its approval screen; VeilPay does not estimate fees.
                </p>

                <div className="action-row action-row-tight">
                  <button
                    className="button primary"
                    onClick={
                      pendingPayment?.operationId
                        ? () => void checkPendingOperation(pendingPayment)
                        : pendingPayment?.outcome === 'submitted'
                          ? undefined
                          : approveFromWallet
                    }
                    disabled={
                      isSending ||
                      isCheckingOperation ||
                      walletState.status !== 'connected' ||
                      network !== 'testnet' ||
                      (pendingPayment !== null &&
                        pendingPayment.walletAddress !== walletState.address) ||
                      (pendingPayment?.outcome === 'submitted' && !pendingPayment.operationId)
                    }
                  >
                    {isSending
                      ? 'Waiting for wallet…'
                      : isCheckingOperation
                        ? 'Checking wallet status…'
                        : pendingPayment?.operationId
                          ? 'Check operation status'
                          : pendingPayment?.outcome === 'submitted'
                            ? 'Status unavailable'
                            : pendingPayment
                              ? 'Review and retry safely (same payment)'
                              : 'Approve in wallet'}
                  </button>
                  {!pendingPayment ? (
                    <button className="button ghost" onClick={() => setReviewOpen(false)}>Cancel</button>
                  ) : null}
                </div>

                {reviewError ? <p className="error-text">{reviewError}</p> : null}
                {walletState.balanceError ? <p className="error-text">{walletState.balanceError}</p> : null}
                {pendingPayment ? (
                  <>
                    {walletState.status !== 'connected' ||
                    walletState.address !== pendingPayment.walletAddress ||
                    network !== pendingPayment.network ? (
                      <p role="status">
                        Connect the originating wallet on {pendingPayment.network} to access this pending operation.
                      </p>
                    ) : null}
                    <p className="activity-description">
                      Pending operation is bound to {pendingPayment.walletAddress} on {pendingPayment.network}.
                      {pendingPayment.operationStatus === 'executing'
                        ? ' The wallet reports that it is executing.'
                        : pendingPayment.operationStatus === 'confirmed'
                          ? ' The wallet reports confirmed; this is not independent chain settlement verification.'
                          : pendingPayment.operationStatus === 'failed'
                            ? ' The wallet reports failure.'
                            : pendingPayment.operationStatus === 'unknown'
                              ? ' The wallet reports unknown; this does not prove that no transaction occurred.'
                              : pendingPayment.operationStatus === 'unavailable'
                                ? ' Status is unavailable; review the originating wallet before taking further action.'
                                : pendingPayment.outcome === 'unresolved' && !pendingPayment.operationId
                                  ? ' The SDK returned no operation ID, so the status API cannot check it. Review the originating wallet before taking further action.'
                                  : ' The result remains unresolved; review the originating wallet before taking further action.'}
                    </p>
                    {pendingPayment.operationStatus === 'confirmed' || pendingPayment.operationStatus === 'failed' ? (
                      <button className="button ghost" type="button" onClick={dismissResolvedOperation}>
                        Dismiss wallet-reported status
                      </button>
                    ) : null}
                    {(pendingPayment.operationStatus === 'unknown' ||
                      pendingPayment.operationStatus === 'unavailable' ||
                      (pendingPayment.outcome === 'unresolved' && !pendingPayment.operationId)) ? (
                      <button
                        className="button ghost"
                        type="button"
                        onClick={acknowledgeRecoveryAfterWalletReview}
                        disabled={
                          walletState.status !== 'connected' ||
                          walletState.address !== pendingPayment.walletAddress ||
                          network !== pendingPayment.network
                        }
                      >
                        Clear only after reviewing the originating wallet
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (route === 'receive') {
      return (
        <div className="card route-card receive-screen">
          <div className="section-title">
            <h3>Receive BDX</h3>
            <span className="badge">Share this address</span>
          </div>

          <div className="wallet-card">
            {walletAddress ? (
              <>
                <div className="receive-qr">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt={`QR code for ${walletAddress}`} />
                  ) : qrError ? (
                    <div className="error-state" role="alert"><p>{qrError}</p></div>
                  ) : (
                    <div className="info-state" role="status"><p>Generating address QR code…</p></div>
                  )}
                </div>
                <div className="wallet-id" aria-label="Receiving address">{walletAddress}</div>
                {qrDataUrl ? (
                  <a
                    className="button secondary"
                    href={qrDataUrl}
                    download="veilpay-beldex-address.png"
                  >
                    Download QR
                  </a>
                ) : null}
                <div className="action-row">
                  <button className="button secondary" onClick={handleCopyAddress} type="button">
                    {copyMessage === 'Address copied.' ? 'Copied' : 'Copy address'}
                  </button>
                  <button className="button secondary" onClick={() => setRoute('wallet')}>View wallet</button>
                </div>
                {copyMessage ? <div className="info-state" role="status"><p>{copyMessage}</p></div> : null}
              </>
            ) : (
              <div
                className={
                  walletState.status === 'error' ||
                  walletState.status === 'not_detected' ||
                  walletState.status === 'unsupported' ||
                  walletState.status === 'locked'
                    ? 'error-state'
                    : 'info-state'
                }
                role="status"
              >
                <p>
                  {walletState.status === 'detecting'
                    ? 'Checking wallet connection…'
                    : walletState.status === 'unsupported' ||
                        walletState.status === 'not_detected' ||
                        walletState.status === 'locked' ||
                        walletState.status === 'error'
                      ? walletState.error
                      : 'Wallet disconnected. Connect to generate a QR code for your Beldex address.'}
                </p>
              </div>
            )}
            {!walletAddress ? (
              <div className="action-row">
                <button className="button primary" onClick={() => setRoute('connect')}>Connect wallet</button>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (route === 'activity') {
      return (
        <section className="card route-card activity-screen">
          <div className="section-title">
            <h3>Activity</h3>
            <span className="badge badge-muted">This app only</span>
          </div>
          {activityList}
        </section>
      );
    }

    if (route === 'settings') {
      return (
        <div className="card route-card settings-screen">
          <div className="section-title">
            <h3>Settings</h3>
          </div>

          <div className="wallet-card">
            <div className="badge-row">
              <span className="badge">Non-custodial</span>
              <span className="badge">Testnet payments only</span>
              <span className="badge">Network: {formatNetworkLabel(network)}</span>
            </div>
            <p>Your Beldex Wallet controls network selection and transaction approval. VeilPay never asks for your private key or recovery phrase.</p>
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="card hero route-card home-screen">
          <div className="eyebrow">VeilPay</div>
          <h2>Simple Beldex payments, without the clutter.</h2>
          <p>Connect your wallet, send BDX, and share a receive address with a clear and privacy-focused flow.</p>
          <div className="action-row">
            <button className="button secondary" onClick={() => setRoute('send')}>Send Payment</button>
            <button className="button ghost" onClick={() => setRoute('receive')}>Receive Payment</button>
          </div>
        </div>
      </>
    );
  })();

  return (
    <div className="app-shell">
      <header className="brand-header" aria-label="VeilPay header">
        <div className="brand" aria-label="VeilPay home">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 64 64" role="img" aria-label="VeilPay logo">
              <defs>
                <linearGradient id="veilpay-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#38A9F9" />
                  <stop offset="100%" stopColor="#8B80F9" />
                </linearGradient>
              </defs>
              <rect x="8" y="10" width="48" height="44" rx="14" fill="url(#veilpay-gradient)" opacity="0.18"/>
              <path d="M18 42V23.2C18 19.9 20.9 17 24.2 17H39.8C43.1 17 46 19.9 46 23.2V42" fill="none" stroke="url(#veilpay-gradient)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M21 33.5C25.5 29.5 28.8 27.5 32 27.5C35.8 27.5 39.8 31 43 34.8" fill="none" stroke="url(#veilpay-gradient)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="32" cy="22" r="5" fill="url(#veilpay-gradient)"/>
            </svg>
          </div>
          <div className="brand-copy">
            <span className="brand-tag">Beldex payments</span>
            <h1>VeilPay</h1>
          </div>
        </div>

        <div className="header-status">
          <span className="status-badge">{getWalletStatusLabel(walletState.status, walletState.network)}</span>
          {route !== 'connect' ? (
            <button
              className="button secondary header-wallet-action"
              type="button"
              onClick={() => setRoute('connect')}
            >
              {walletState.status === 'connected' ? 'Manage wallet' : 'Connect'}
            </button>
          ) : null}
        </div>
      </header>

      <nav className="top-nav" aria-label="Main navigation">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`nav-item${route === item.key ? ' active' : ''}`}
            aria-current={route === item.key ? 'page' : undefined}
            onClick={() => setRoute(item.key)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-title">
            <h2>{routeTitles[route]}</h2>
            <p>{routeDescriptions[route]}</p>
          </div>
        </header>

        <div className={`content-grid${route === 'activity' ? ' activity-page-grid' : ''}`}>
          {lastAction ? <div className="status-banner">{lastAction}</div> : null}
          {currentRouteContent}

          {route !== 'activity' ? (
            <section className="card activity-card">
              <div className="section-title">
                <h3>Recent activity</h3>
                <span className="badge badge-muted">This app only</span>
              </div>
              {activityList}
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default App;
