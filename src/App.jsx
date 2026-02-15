import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Download,
  FolderSearch,
  Gauge,
  PlayCircle,
  RefreshCcw,
  Square,
  Terminal,
  Timer
} from 'lucide-react';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from './components/ui/card';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Badge } from './components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from './components/ui/table';

const DEFAULT_PROJECT = '/Users/matheuspuppe/Desktop/Projetos/github/browser-sql-ide';

function statusVariant(status) {
  if (status === 'running' || status === 'executing') return 'success';
  if (status === 'paused') return 'warning';
  if (status === 'error' || status === 'failed' || status === 'halted') return 'destructive';
  return 'secondary';
}

function getCodexStatus(processes, status) {
  const codexProcess = processes.find((p) => p.command.includes('codex exec'));
  if (codexProcess) {
    return { label: 'running', variant: 'success', detail: `PID ${codexProcess.pid} • ${codexProcess.etime}` };
  }
  if (status?.last_action === 'executing') {
    return { label: 'starting', variant: 'warning', detail: 'Aguardando processo codex aparecer' };
  }
  if (status?.status === 'halted' || status?.status === 'error') {
    return { label: 'error', variant: 'destructive', detail: status?.exit_reason || 'Loop interrompido' };
  }
  return { label: 'idle', variant: 'secondary', detail: 'Sem execução ativa' };
}

export function App() {
  const [projectPath, setProjectPath] = useState(DEFAULT_PROJECT);
  const [args, setArgs] = useState('--sandbox workspace-write --full-auto --timeout 20 --calls 30 --verbose');
  const [processes, setProcesses] = useState([]);
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState('');
  const [fixPlan, setFixPlan] = useState('');
  const [message, setMessage] = useState('');

  async function refreshProcesses() {
    try {
      const res = await fetch('/api/processes');
      const data = await res.json();
      setProcesses(data.processes || []);
    } catch {
      setMessage('Erro ao carregar processos');
    }
  }

  async function refreshProject() {
    try {
      const res = await fetch(`/api/project-status?projectPath=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'Erro ao carregar projeto');
        return;
      }
      setStatus(data.status || null);
      setLogs(data.logs || '');
      setFixPlan(data.fixPlan || '');
    } catch {
      setMessage('Erro de rede ao consultar status do projeto');
    }
  }

  async function startRalph() {
    setMessage('Iniciando Ralph...');
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, args })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`Erro: ${data.error}`);
        return;
      }
      setMessage(`Ralph iniciado (PID ${data.pid})`);
      await refreshProcesses();
      await refreshProject();
    } catch {
      setMessage('Erro ao iniciar Ralph');
    }
  }

  async function stopProcess(pid) {
    try {
      const res = await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`Erro ao parar PID ${pid}: ${data.error}`);
        return;
      }
      setMessage(`Processo ${pid} finalizado`);
      await refreshProcesses();
      await refreshProject();
    } catch {
      setMessage(`Erro ao parar PID ${pid}`);
    }
  }

  async function exportDiagnostics() {
    try {
      setMessage('Gerando pacote de diagnostico...');
      const res = await fetch(`/api/export-diagnostics?projectPath=${encodeURIComponent(projectPath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage(`Erro ao exportar: ${data.error || 'falha inesperada'}`);
        return;
      }

      const blob = await res.blob();
      const contentDisposition = res.headers.get('Content-Disposition') || '';
      const match = /filename=\"?([^\";]+)\"?/i.exec(contentDisposition);
      const fileName = match?.[1] || `ralph-diagnostics-${Date.now()}.json`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setMessage(`Diagnostico exportado: ${fileName}`);
    } catch {
      setMessage('Erro ao exportar diagnostico');
    }
  }

  useEffect(() => {
    refreshProcesses();
    refreshProject();
    const id = setInterval(() => {
      refreshProcesses();
      refreshProject();
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const processCount = processes.length;
  const callsSummary = status
    ? `${status.calls_made_this_hour ?? 0}/${status.max_calls_per_hour ?? 100}`
    : '--';

  const headlineStatus = useMemo(() => {
    if (!status?.status) return 'idle';
    return status.status;
  }, [status]);
  const codexStatus = useMemo(() => getCodexStatus(processes, status), [processes, status]);

  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-10 pt-8 md:px-8">
      <section className="mb-6 overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-r from-sky-500/20 via-cyan-300/10 to-emerald-500/20 p-1 shadow-panel">
        <div className="rounded-[14px] bg-background/85 p-6 md:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/80 px-3 py-1 text-xs text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" /> Ralph + Codex Control Center
              </div>
              <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Ralph Control UI</h1>
              <p className="max-w-2xl text-sm text-muted-foreground md:text-base">
                Painel visual para monitorar loops, acompanhar timers, controlar processos e inspecionar logs em tempo real.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={statusVariant(headlineStatus)} className="px-3 py-1 text-xs">
                <Activity className="mr-1.5 h-3.5 w-3.5" />
                {headlineStatus.toUpperCase()}
              </Badge>
              <Badge variant={codexStatus.variant} className="px-3 py-1 text-xs">
                <Terminal className="mr-1.5 h-3.5 w-3.5" />
                CODEX: {codexStatus.label.toUpperCase()}
              </Badge>
              <Badge variant="outline" className="px-3 py-1 text-xs">
                <Timer className="mr-1.5 h-3.5 w-3.5" /> Sessão: {status?.session_elapsed_hms ?? '00:00:00'}
              </Badge>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Loop Atual</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Gauge className="h-5 w-5 text-primary" /> #{status?.current_loop ?? 0}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Total executado: {status?.total_loops_executed ?? 0}</CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Timer do Loop</CardDescription>
            <CardTitle className="text-2xl">{status?.loop_elapsed_hms ?? '00:00:00'}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Status: {status?.last_action ?? 'idle'}</CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Processos Ativos</CardDescription>
            <CardTitle className="text-2xl">{processCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Ralph/Codex detectados no host local</CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Calls na Hora</CardDescription>
            <CardTitle className="text-2xl">{callsSummary}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Limite configurado no loop atual</CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Status do Codex</CardDescription>
            <CardTitle className="text-2xl">{codexStatus.label}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">{codexStatus.detail}</CardContent>
        </Card>
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FolderSearch className="h-4 w-4 text-primary" /> Execução
            </CardTitle>
            <CardDescription>Defina projeto, argumentos e controle a execução do Ralph.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Projeto</label>
              <Input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Args do Ralph</label>
              <Textarea
                className="min-h-[72px] font-mono"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={startRalph}>
                <PlayCircle className="h-4 w-4" /> Rodar Ralph
              </Button>
              <Button variant="outline" onClick={exportDiagnostics}>
                <Download className="h-4 w-4" /> Exportar Diagnostico
              </Button>
              <Button variant="secondary" onClick={refreshProject}>
                <RefreshCcw className="h-4 w-4" /> Atualizar Status
              </Button>
              <Button variant="outline" onClick={refreshProcesses}>
                <RefreshCcw className="h-4 w-4" /> Atualizar Processos
              </Button>
            </div>

            <div className="rounded-md border border-border/70 bg-card/60 px-3 py-2 text-sm text-muted-foreground">
              {message || 'Aguardando ação...'}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Status do Projeto</CardTitle>
            <CardDescription>Snapshot bruto do `.ralph/status.json`.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="log-surface max-h-[330px] overflow-auto rounded-md border border-border/60 bg-background/60 p-3 text-xs text-slate-200">
              {JSON.stringify(status, null, 2) || 'Sem status'}
            </pre>
          </CardContent>
        </Card>
      </section>

      <section className="mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Processos Ralph/Codex</CardTitle>
            <CardDescription>Finalize processos diretamente pelo painel.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PID</TableHead>
                  <TableHead>PPID</TableHead>
                  <TableHead>Tempo</TableHead>
                  <TableHead>Comando</TableHead>
                  <TableHead className="w-[120px]">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {processes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      Nenhum processo Ralph/Codex em execução.
                    </TableCell>
                  </TableRow>
                ) : (
                  processes.map((p) => (
                    <TableRow key={p.pid}>
                      <TableCell className="font-semibold">{p.pid}</TableCell>
                      <TableCell>{p.ppid}</TableCell>
                      <TableCell>{p.etime}</TableCell>
                      <TableCell className="max-w-[620px] break-words font-mono text-xs text-muted-foreground">
                        {p.command}
                      </TableCell>
                      <TableCell>
                        <Button variant="destructive" size="sm" onClick={() => stopProcess(p.pid)}>
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Logs (`ralph.log`)</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="log-surface max-h-[420px] overflow-auto rounded-md border border-border/60 bg-background/60 p-3 text-xs text-slate-200">
              {logs || 'Sem logs disponíveis.'}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Fix Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="log-surface max-h-[420px] overflow-auto rounded-md border border-border/60 bg-background/60 p-3 text-xs text-slate-200">
              {fixPlan || 'Sem fix plan disponível.'}
            </pre>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
