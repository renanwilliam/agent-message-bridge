export interface SessionState {
  authenticated: boolean;
  busy: boolean;
  message: string;
}
export interface Session {
  oauth: boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionState;
  getToken(): string;
  setToken(value: string): void;
  startLogin(): Promise<void>;
  suspend(): void;
  clear(message?: string): void;
  ready: Promise<void>;
}
declare global {
  var bridgeSession: Session;
}
export const session = globalThis.bridgeSession;
export async function query<T>(body: unknown, signal: AbortSignal): Promise<T> {
  const token = session.getToken();
  if (!token) throw new Error('Sessão expirada. Entre novamente.');
  const response = await fetch('/history', {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401)
      session.clear('Sessão expirada. Entre novamente.');
    throw new Error(
      response.status === 401
        ? 'Sessão expirada. Entre novamente.'
        : response.status === 403
          ? 'Sua conta não tem permissão para consultar o histórico.'
          : response.status === 404
            ? 'Conversa indisponível para esta conta.'
            : 'Não foi possível consultar o histórico. Tente novamente.',
    );
  }
  return response.json() as Promise<T>;
}
