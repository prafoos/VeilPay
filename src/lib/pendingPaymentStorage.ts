export type PendingPayment = {
  recipient: string;
  amount: string;
  idempotencyKey: string;
  walletAddress: string;
  network: 'testnet';
  outcome: 'unresolved' | 'submitted';
  operationId?: string;
  operationStatus?: 'executing' | 'confirmed' | 'failed' | 'unknown' | 'unavailable';
};

const STORAGE_KEY = 'veilpay.pending-bdx-operation.v1';
const ID_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

function isPendingPayment(value: unknown): value is PendingPayment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.recipient === 'string' &&
    pending.recipient.length > 0 &&
    typeof pending.amount === 'string' &&
    ID_DECIMAL_PATTERN.test(pending.amount) &&
    typeof pending.idempotencyKey === 'string' &&
    IDENTITY_PATTERN.test(pending.idempotencyKey) &&
    typeof pending.walletAddress === 'string' &&
    pending.walletAddress.length > 0 &&
    pending.network === 'testnet' &&
    (pending.outcome === 'unresolved' || pending.outcome === 'submitted') &&
    (pending.operationId === undefined ||
      (typeof pending.operationId === 'string' && pending.operationId.length > 0 && pending.operationId.length <= 128)) &&
    (pending.operationStatus === undefined ||
      ['executing', 'confirmed', 'failed', 'unknown', 'unavailable'].includes(String(pending.operationStatus)))
  );
}

export function loadPendingPayment(): { payment: PendingPayment | null; error?: string } {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) {
      return { payment: null };
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isPendingPayment(parsed)) {
      return { payment: null, error: 'Stored pending payment data is invalid and was not restored.' };
    }
    return {
      payment: {
        recipient: parsed.recipient,
        amount: parsed.amount,
        idempotencyKey: parsed.idempotencyKey,
        walletAddress: parsed.walletAddress,
        network: 'testnet',
        outcome: parsed.outcome,
        ...(parsed.operationId ? { operationId: parsed.operationId } : {}),
        ...(parsed.operationStatus ? { operationStatus: parsed.operationStatus } : {}),
      },
    };
  } catch {
    return { payment: null, error: 'Pending payment recovery data could not be read from this browser.' };
  }
}

export function savePendingPayment(payment: PendingPayment): string | null {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payment));
    return null;
  } catch {
    return 'Pending transaction details could not be saved. No transaction was requested.';
  }
}

export function removePendingPayment(): string | null {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return 'The resolved transaction record could not be removed from this browser.';
  }
}
