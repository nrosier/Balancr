/**
 * No `@types` package exists for `svg-to-pdfkit`; this is the minimal shape
 * `pdf.ts` actually calls.
 */
declare module 'svg-to-pdfkit' {
  export default function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string,
    x: number,
    y: number,
    options?: { width?: number; height?: number; assumePt?: boolean },
  ): void
}
