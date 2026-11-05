// @vitest-environment node

import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import { generateAddressQr } from './receiveQr';

describe('Beldex receiving QR codes', () => {
  it('encodes the exact supplied address in the generated QR payload', async () => {
    const address = 'bxExampleAddressPayload';
    const encoder = vi.spyOn(QRCode, 'toDataURL');
    const dataUrl = await generateAddressQr(address);
    expect(encoder).toHaveBeenCalledWith(address, expect.objectContaining({
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 192,
    }));
    const encoded = QRCode.create(address, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 192,
    });
    const decodedPayload = encoded.segments
      .map((segment) => Buffer.from(segment.data).toString('utf8'))
      .join('');

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(decodedPayload).toBe(address);
    encoder.mockRestore();
  });

  it.each(['', '   '])('refuses to create a QR code from an unavailable address (%s)', async (address) => {
    await expect(generateAddressQr(address)).rejects.toThrow('connected Beldex address is required');
  });
});
