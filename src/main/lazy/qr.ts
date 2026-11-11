// The QR code library, built as its own bundle (see ../lazy.ts): it loads the
// first time a Wi-Fi network is shared.
import QRCode from "qrcode";

export function svg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
}
