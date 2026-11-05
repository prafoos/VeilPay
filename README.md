# VeilPay

VeilPay is a non-custodial Beldex payment interface built around the Beldex Wallet browser extension and the official `@bdxi/web3js` SDK. It aims to make common BDX payment steps easier to follow without replacing the wallet or holding wallet secrets.

By adding a focused payment flow on top of Beldex wallet infrastructure, VeilPay is intended to make connecting, reviewing a payment, and sharing a receive address more approachable for Beldex users. It complements rather than replaces the official wallet.

## What is implemented

- Connect, manage, and disconnect a Beldex Wallet.
- Display wallet connection and network status and the BDX balance provided by the wallet.
- Prepare and review a BDX payment, then request approval in the wallet.
- Share a receive address with a QR code.
- Show submissions made through VeilPay during the current session and restore unresolved payment status after reload.
- Optionally read Privacy Token balances reported by the connected wallet. Privacy Token support is read-only; token transfers and manual token-ID lookup are not implemented.
- Provide a responsive sky-blue neumorphism interface.

## Network and safety limitations

- Payments are restricted to a wallet verified as **Beldex Testnet**. Do not use this app for Mainnet or production payments.
- A compatible Beldex Wallet browser extension is required. The wallet controls connection approval, network selection, and transaction approval.
- VeilPay does not ask for or store private keys or recovery phrases. Never enter wallet secrets into the app.
- The browser stores only minimal non-secret pending-payment metadata for recovery; wallet secrets are never persisted by VeilPay.
- Transaction status shown by the wallet is not independent proof of chain settlement. Check the wallet or authoritative network tools before treating a payment as settled.
- The app has not been verified against a live wallet extension or live Testnet in every environment. Automated and mocked tests do not establish live network support.
- Privacy Token information and balances are read-only and depend on what the wallet and SDK report. Privacy Token transfers, Mainnet support, and Swap are not implemented.

## Run locally

Requirements: Node.js and npm, plus a Beldex Wallet extension for wallet-connected use.

```powershell
npm ci
npm run dev
```

Open the local URL printed by Vite. You can inspect the interface without connecting a wallet; wallet actions require the extension and its approval.

## Checks

```powershell
npm run test:run
npm run build
npm run lint
npm audit
```

## Project direction

VeilPay is currently a Testnet-oriented payment UX experiment for the Beldex ecosystem. Future work should focus on user research, live-wallet compatibility verification, accessibility, and reliable payment-status evidence before considering any production or Mainnet use. No roadmap item should be interpreted as a currently supported feature.
