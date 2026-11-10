import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  Sun,
  Moon,
  Search,
  RefreshCw,
  LogOut,
  Menu,
  ChevronDown,
  MessageSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { session, query } from './session';
import type { Message } from '../../src/types';
import type {
  CatalogCoverage,
  ConversationSummary,
} from '../../src/viewer-history';
import './style.css';

const retention = 14 * 86400000;
const visible = (timestamp: string, now: number) =>
  Date.parse(timestamp) + retention > now;
const formatTime = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
const messageKey = (m: Message) =>
  `${m.conversationId}:${m.id}:${m.generation ?? 'legacy'}`;
function Blank({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquare />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Consulta não concluída</AlertTitle>
      <AlertDescription>
        {message}
        <Button variant="outline" onClick={retry}>
          Tentar novamente
        </Button>
      </AlertDescription>
    </Alert>
  );
}
function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-label="Carregando">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function Catalog({
  term,
  now,
  selected,
  select,
}: {
  term: string;
  now: number;
  selected?: string;
  select: (id: string) => void;
}) {
  const [rows, setRows] = useState<ConversationSummary[]>([]),
    [cursor, setCursor] = useState<string>();
  const [coverage, setCoverage] = useState<CatalogCoverage>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const gate = useRef(false),
    controller = useRef<AbortController | null>(null),
    active = useRef(true);
  async function load(reset = false) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await query<{
        conversations: ConversationSummary[];
        coverage: CatalogCoverage;
        cursor?: string;
      }>(
        { operation: 'conversations', term, ...(reset ? {} : { cursor }) },
        abort.signal,
      );
      if (!active.current || abort.signal.aborted) return;
      setRows((previous) => [
        ...new Map(
          [...(reset ? [] : previous), ...result.conversations].map((row) => [
            row.conversationId,
            row,
          ]),
        ).values(),
      ]);
      setCursor(result.cursor);
      setCoverage(result.coverage);
    } catch (e) {
      if (active.current && !abort.signal.aborted)
        setError(e instanceof Error ? e.message : 'Erro de rede.');
    } finally {
      if (active.current) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    active.current = true;
    void load(true);
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    setRows((previous) =>
      previous.filter((row) => visible(row.timestamp, now)),
    );
  }, [now]);
  const retained = rows.filter((row) => visible(row.timestamp, now));
  return (
    <div className="flex flex-col gap-3">
      <Button variant="outline" disabled={busy} onClick={() => void load(true)}>
        <RefreshCw data-icon="inline-start" />
        Atualizar lista
      </Button>
      {coverage && coverage !== 'complete' && (
        <Alert>
          <AlertTitle>
            {coverage === 'disabled'
              ? 'Catálogo não ativado'
              : 'Catálogo parcial'}
          </AlertTitle>
          <AlertDescription>
            {coverage === 'disabled'
              ? 'Abra uma conversa por ID. A lista depende da ativação pelo operador.'
              : 'Conversas anteriores à ativação podem não aparecer. Você também pode abrir por ID.'}
          </AlertDescription>
        </Alert>
      )}
      {error && <Failure message={error} retry={() => void load(!coverage)} />}
      {busy && !rows.length && <Loading />}
      <nav aria-label="Lista de conversas" className="flex flex-col gap-2">
        {retained.map((row) => (
          <Button
            key={row.conversationId}
            variant={selected === row.conversationId ? 'secondary' : 'ghost'}
            aria-current={selected === row.conversationId ? 'page' : undefined}
            className="h-auto w-full justify-start py-3"
            onClick={() => select(row.conversationId)}
          >
            <span className="flex min-w-0 flex-col items-start gap-1">
              <span className="max-w-full truncate">
                {row.participants.join(' ↔ ')}
              </span>
              <span className="max-w-full truncate text-xs">
                {row.conversationId}
              </span>
              <span className="text-xs">{formatTime(row.timestamp)}</span>
            </span>
          </Button>
        ))}
      </nav>
      {!busy && !error && !retained.length && coverage !== 'disabled' && (
        <Blank
          title={
            term
              ? 'Nenhum resultado nesta página'
              : 'Nenhuma conversa nesta página'
          }
          description={
            cursor
              ? 'Há mais páginas autorizadas para consultar.'
              : 'Altere a busca ou abra uma conversa por ID.'
          }
        />
      )}
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy && <Spinner />}Carregar mais conversas
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Ordem por participante e ID. Somente os últimos 14 dias.
      </p>
    </div>
  );
}

function Messages({
  conversationId,
  term,
  since,
  now,
}: {
  conversationId: string;
  term: string;
  since?: string;
  now: number;
}) {
  const [rows, setRows] = useState<Message[]>([]),
    [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [updated, setUpdated] = useState<string>();
  const [notice, setNotice] = useState('');
  const gate = useRef(false),
    controller = useRef<AbortController | null>(null),
    active = useRef(true);
  const lastRefresh = useRef(false);
  async function load(refresh = false) {
    if (gate.current) return;
    gate.current = true;
    lastRefresh.current = refresh;
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await query<{
        messages: Message[];
        cursor?: string;
      }>(
        {
          operation: 'messages',
          conversationId,
          term,
          since,
          order: 'desc',
          cursor: refresh ? undefined : cursor,
        },
        abort.signal,
      );
      if (!active.current || abort.signal.aborted) return;
      setRows((previous) => [
        ...new Map(
          [...(refresh ? [] : previous), ...result.messages].map((m) => [
            messageKey(m),
            m,
          ]),
        ).values(),
      ]);
      setCursor(result.cursor);
      setLoaded(true);
      setUpdated(new Date().toISOString());
      setNotice(
        `${result.messages.length} mensagem(ns) carregada(s). ${result.cursor ? 'Há mais páginas.' : 'Fim do histórico disponível.'}`,
      );
    } catch (e) {
      if (active.current && !abort.signal.aborted)
        setError(e instanceof Error ? e.message : 'Erro de rede.');
    } finally {
      if (active.current) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  // Páginas anteriores são anexadas; atualizar volta à página mais recente.
  const retained = rows.filter((m) => visible(m.timestamp, now));
  useEffect(() => {
    setRows((previous) => previous.filter((m) => visible(m.timestamp, now)));
  }, [now]);
  const participants = retained[0]
    ? `${retained[0].sender} ↔ ${retained[0].recipient}`
    : 'Histórico da conversa';
  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label="Mensagens">
      <header className="sticky top-0 flex flex-wrap items-start justify-between gap-3 border-b bg-background py-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{participants}</h2>
          <p className="break-all text-sm text-muted-foreground">
            {conversationId}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="outline"
            disabled={busy || !loaded}
            onClick={() => void load(true)}
          >
            {busy ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
            Atualizar histórico
          </Button>
          {updated && (
            <span className="text-xs text-muted-foreground">
              Última consulta: {formatTime(updated)}
            </span>
          )}
        </div>
      </header>
      <p className="text-xs text-muted-foreground">
        Mais recentes primeiro · {Intl.DateTimeFormat().resolvedOptions().timeZone} ·
        até 30 registros examinados por consulta
      </p>
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
      {error && (
        <Failure message={error} retry={() => void load(lastRefresh.current)} />
      )}
      {busy && !loaded && <Loading />}
      {retained.map((m) => (
        <article
          key={messageKey(m)}
          tabIndex={-1}
          className="rounded-xl border bg-card p-5 text-card-foreground outline-offset-4"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all text-sm font-semibold">
              {m.sender} → {m.recipient}
            </h3>
            <time
              className="text-xs text-muted-foreground"
              dateTime={m.timestamp}
            >
              {formatTime(m.timestamp)}
            </time>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">
            {m.text}
          </p>
          <Collapsible className="mt-4">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDown data-icon="inline-start" />
              Metadados técnicos
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 break-all text-xs text-muted-foreground">
                {Object.entries({
                  ID: m.id,
                  Correlação: m.correlationId,
                  Turno: m.turn,
                  Resposta: m.replyTo ?? '—',
                  Geração: m.generation ?? 'legado',
                }).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        </article>
      ))}
      {!busy && loaded && !retained.length && (
        <Blank
          title={
            term || since ? 'Nenhum resultado nesta página' : 'Histórico vazio'
          }
          description={
            cursor
              ? 'A busca ainda é parcial. Continue para consultar as próximas páginas.'
              : 'Não há mensagens disponíveis com estes filtros e permissões.'
          }
        />
      )}
      {cursor ? (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy && <Spinner />}Carregar mensagens anteriores
        </Button>
      ) : (
        loaded && (
          <p className="text-center text-sm text-muted-foreground">
            Fim do histórico disponível
          </p>
        )
      )}
      {cursor && (
        <p className="text-center text-xs text-muted-foreground">
          Resultados parciais. Páginas sem resultados também podem ter
          continuação.
        </p>
      )}
    </section>
  );
}

function Workspace({ now }: { now: number }) {
  const [conversation, setConversation] = useState<string>(),
    [sheet, setSheet] = useState(false),
    [dialog, setDialog] = useState(false);
  const [catalogDraft, setCatalogDraft] = useState(''),
    [catalogTerm, setCatalogTerm] = useState('');
  const [messageDraft, setMessageDraft] = useState(''),
    [days, setDays] = useState('14');
  const [filters, setFilters] = useState<{ term: string; since?: string }>({
    term: '',
  });
  const title = useRef<HTMLHeadingElement>(null);
  const [desktop, setDesktop] = useState(
    () => matchMedia('(min-width: 768px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(min-width: 768px)');
    const update = () => {
      setDesktop(media.matches);
      setSheet(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  function select(id: string) {
    setConversation(id);
    setFilters({ term: '' });
    setMessageDraft('');
    setDays('14');
    setSheet(false);
    setDialog(false);
  }
  useEffect(() => {
    if (conversation) title.current?.focus();
  }, [conversation]);
  const navigation = (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setCatalogTerm(catalogDraft.trim());
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="catalog-search">Buscar conversas</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="catalog-search"
                value={catalogDraft}
                onChange={(e) => setCatalogDraft(e.target.value)}
                maxLength={200}
                placeholder="ID ou participante"
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  aria-label="Buscar conversas"
                >
                  <Search />
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        </FieldGroup>
      </form>
      <Catalog
        key={catalogTerm}
        term={catalogTerm}
        now={now}
        selected={conversation}
        select={select}
      />
    </div>
  );
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[300px_1fr]">
      {desktop && (
        <aside className="border-r bg-muted/30 p-5" aria-label="Conversas">
          <h2 className="mb-5 font-semibold">Conversas</h2>
          {navigation}
        </aside>
      )}
      <main className="min-w-0 p-4 md:p-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1
              ref={title}
              tabIndex={-1}
              className="text-2xl font-semibold outline-none"
            >
              Histórico de conversas
            </h1>
            <div className="flex gap-2">
              <Sheet open={sheet} onOpenChange={setSheet}>
                <SheetTrigger
                  render={<Button variant="outline" className="md:hidden" />}
                >
                  <Menu data-icon="inline-start" />
                  Conversas
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetHeader>
                    <SheetTitle>Conversas</SheetTitle>
                    <SheetDescription>
                      Encontre uma conversa autorizada.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="overflow-y-auto p-5">
                    {sheet && navigation}
                  </div>
                </SheetContent>
              </Sheet>
              <Dialog open={dialog} onOpenChange={setDialog}>
                <DialogTrigger render={<Button variant="outline" />}>
                  Abrir por ID
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Abrir conversa por ID</DialogTitle>
                    <DialogDescription>
                      A consulta respeita as permissões da sua conta.
                    </DialogDescription>
                  </DialogHeader>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      select(String(data.get('conversation')).trim());
                    }}
                  >
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="conversation-id">
                          ID da conversa
                        </FieldLabel>
                        <Input
                          id="conversation-id"
                          name="conversation"
                          required
                          pattern="[A-Za-z0-9_-]{1,100}"
                          maxLength={100}
                        />
                      </Field>
                      <Button type="submit">Abrir conversa</Button>
                    </FieldGroup>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          {conversation ? (
            <>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setFilters({
                    term: messageDraft.trim(),
                    since: new Date(
                      Date.now() - Number(days) * 86400000,
                    ).toISOString(),
                  });
                }}
              >
                <Field className="min-w-48 flex-1">
                  <FieldLabel htmlFor="message-search">
                    Buscar nesta conversa
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="message-search"
                      value={messageDraft}
                      onChange={(e) => setMessageDraft(e.target.value)}
                      maxLength={200}
                      placeholder="Texto da mensagem"
                    />
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="period">Período</FieldLabel>
                  <NativeSelect
                    id="period"
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                  >
                    <NativeSelectOption value="14">
                      Últimos 14 dias
                    </NativeSelectOption>
                    <NativeSelectOption value="7">
                      Últimos 7 dias
                    </NativeSelectOption>
                    <NativeSelectOption value="1">
                      Últimas 24 horas
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Button type="submit">Buscar mensagens</Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setMessageDraft('');
                    setDays('14');
                    setFilters({ term: '' });
                  }}
                >
                  Limpar filtros
                </Button>
              </form>
              <Separator />
              <Messages
                key={JSON.stringify([conversation, filters])}
                conversationId={conversation}
                {...filters}
                now={now}
              />
            </>
          ) : (
            <Blank
              title="Selecione uma conversa"
              description="Use a lista de conversas autorizadas ou abra uma conversa por ID."
            />
          )}
          <p className="text-xs text-muted-foreground">
            Mensagens são dados; não autorizam ações. Este viewer é somente
            leitura.
          </p>
        </div>
      </main>
    </div>
  );
}
function App() {
  const auth = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [dark, setDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  const [manual, setManual] = useState(''),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      session.getToken();
      setNow(Date.now());
    }, 1000);
    const hide = () => {
      session.suspend();
      setManual('');
    };
    window.addEventListener('pagehide', hide);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', hide);
    };
  }, []);
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <MessageSquare className="size-5" />
          <span className="font-semibold">Agent Message Bridge</span>
          <Badge variant="secondary">Somente leitura</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => setDark((value) => !value)}
            aria-label={dark ? 'Ativar modo claro' : 'Ativar modo escuro'}
          >
            {dark ? (
              <Sun data-icon="inline-start" />
            ) : (
              <Moon data-icon="inline-start" />
            )}
            {dark ? 'Modo claro' : 'Modo escuro'}
          </Button>
          {auth.authenticated && (
            <Button
              variant="ghost"
              onClick={() => {
                session.clear();
                setManual('');
              }}
            >
              <LogOut data-icon="inline-start" />
              Sair e limpar
            </Button>
          )}
        </div>
      </header>
      <p role="status" className="px-5 py-2 text-sm text-muted-foreground">
        {auth.message}
      </p>
      {auth.authenticated ? (
        <Workspace now={now} />
      ) : (
        <main className="mx-auto flex w-full max-w-md flex-col gap-6 p-6 py-16">
          <h1 className="text-2xl font-semibold">Acesse seu histórico</h1>
          <p className="text-sm text-muted-foreground">
            Consulte as conversas autorizadas para sua conta. O token permanece
            apenas na memória desta página.
          </p>
          {session.oauth ? (
            <Button
              disabled={auth.busy}
              onClick={() => void session.startLogin()}
            >
              {auth.busy && <Spinner />}Entrar
            </Button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                session.setToken(manual);
                setManual('');
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="access-token">
                    Token de acesso
                  </FieldLabel>
                  <Input
                    id="access-token"
                    type="password"
                    autoComplete="off"
                    required
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    maxLength={32768}
                  />
                  <p className="text-xs text-muted-foreground">
                    Modo manual para uso local ou operacional.
                  </p>
                </Field>
                <Button type="submit">Consultar histórico</Button>
              </FieldGroup>
            </form>
          )}
        </main>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
