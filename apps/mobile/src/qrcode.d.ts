// Minimal types for the `qrcode` package (only what QrCode in kit.tsx uses).
declare module "qrcode" {
  interface QRCodeModules {
    size: number;
    get(x: number, y: number): boolean | number;
  }
  interface QRCodeData {
    modules: QRCodeModules;
  }
  const QRCode: {
    create(
      text: string,
      options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }
    ): QRCodeData;
  };
  export default QRCode;
}
