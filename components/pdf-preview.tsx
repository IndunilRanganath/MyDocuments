'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { PreviewError } from './document-preview';

// Bundle the matching worker locally; decrypted files never leave this browser.
GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export default function PdfPreview({ data, name, onRetry }: { data: ArrayBuffer; name: string; onRetry: () => void }) {
  const container = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1); const [width, setWidth] = useState(0);
  const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    // PDF.js transfers its buffer to the worker, so give it an independent copy.
    const task = getDocument({ data: new Uint8Array(data.slice(0)), useSystemFonts: true, useWasm: false });
    void task.promise.then(pdf => { if (active) setDocument(pdf); }).catch(() => { if (active) { setFailed(true); setLoading(false); } });
    return () => { active = false; void task.destroy().catch(() => {}); };
  }, [data]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width - 24))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !width || !canvas.current) return;
    let active = true; let render: RenderTask | undefined;
    const target = canvas.current;
    setLoading(true);
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (!active) return;
      const viewport = pdfPage.getViewport({ scale: Math.min(width / pdfPage.getViewport({ scale: 1 }).width, 2) });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      target.width = Math.ceil(viewport.width * ratio); target.height = Math.ceil(viewport.height * ratio);
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`;
      render = pdfPage.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (active) setLoading(false);
    })().catch(() => { if (active) { setFailed(true); setLoading(false); } });
    return () => { active = false; render?.cancel(); target.width = 0; target.height = 0; };
  }, [document, page, width]);

  if (failed) return <PreviewError onRetry={onRetry}/>;
  return <div className="pdf-viewer" ref={container} aria-busy={loading}>
    <div className="pdf-pages">
      {loading && <LoaderCircle className="spin preview-spinner" aria-label="Loading PDF" size={24}/>}
      <canvas ref={canvas} role="img" aria-label={`${name}, page ${page}`} style={{ visibility: loading ? 'hidden' : 'visible' }}/>
    </div>
    {document && <nav className="pdf-controls" aria-label="PDF pages">
      <button className="icon-button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => { setLoading(true); setPage(p => p - 1); }}><ChevronLeft size={20}/></button>
      <span role="status">Page {page} of {document.numPages}</span>
      <button className="icon-button" aria-label="Next page" disabled={loading || page >= document.numPages} onClick={() => { setLoading(true); setPage(p => p + 1); }}><ChevronRight size={20}/></button>
    </nav>}
  </div>;
}
