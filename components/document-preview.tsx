'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { FileText, LoaderCircle } from 'lucide-react';

const PdfPreview = dynamic(() => import('./pdf-preview'), {
  ssr: false,
  loading: () => <LoaderCircle className="spin" aria-label="Loading PDF" size={24}/>,
});

export function PreviewError({ onRetry }: { onRetry: () => void }) {
  return <div className="preview-error" role="status"><FileText size={40}/><p>Preview unavailable</p><p>You can still download the original file.</p><button className="text-button" onClick={onRetry}>Try again</button></div>;
}

export function DocumentPreview({ url, data, mime, name, onRetry }: { url: string; data: ArrayBuffer; mime: string; name: string; onRetry: () => void }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  if (mime === 'application/pdf') return <PdfPreview data={data} name={name} onRetry={onRetry}/>;
  if (status === 'error') return <PreviewError onRetry={onRetry}/>;
  return <div className="image-preview-wrap" aria-busy={status === 'loading'}>
    {status === 'loading' && <LoaderCircle className="spin preview-spinner" aria-label="Loading image" size={24}/>}
    <img src={url} alt={name} className="image-preview" onLoad={() => setStatus('ready')} onError={() => setStatus('error')}/>
  </div>;
}
