export async function api<T = Record<string, never>>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('mydocuments:locked')); throw new Error(data.error || 'Please try again.'); }
  return data;
}
