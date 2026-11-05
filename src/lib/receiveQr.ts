import QRCode from 'qrcode';

export async function generateAddressQr(address: string): Promise<string> {
  if (!address.trim()) {
    throw new Error('A connected Beldex address is required to generate a QR code.');
  }
  return QRCode.toDataURL(address, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 192,
  });
}
