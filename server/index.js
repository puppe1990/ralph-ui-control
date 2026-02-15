const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_RALPH_SCRIPT = '/Users/matheuspuppe/Desktop/Projetos/github/ralph-codex/ralph_loop.sh';

app.use(cors());
app.use(express.json());

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function tailFile(filePath, lines = 80) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function listRecentLogFiles(logDir, limit = 8) {
  try {
    return fs
      .readdirSync(logDir)
      .map((name) => path.join(logDir, name))
      .filter((fullPath) => fs.statSync(fullPath).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function listRecentLogFilesByPrefix(logDir, prefix, limit = 8) {
  try {
    return fs
      .readdirSync(logDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(logDir, name))
      .filter((fullPath) => fs.statSync(fullPath).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function normalizeStatusLine(line) {
  return stripAnsi(line)
    .replace(/[│╭╮╰╯]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLimitLine(line) {
  const normalized = normalizeStatusLine(line);
  if (!normalized) return null;

  const leftMatch = normalized.match(/(\d{1,3})\s*%\s*left/i);
  const usedMatch = normalized.match(/(\d{1,3})\s*%\s*used/i);
  const genericPercentMatch = normalized.match(/(\d{1,3})\s*%/i);
  const resetParenMatch = normalized.match(/\(resets?\s+([^)]+)\)/i);
  const compactResetMatch = normalized.match(/(\d{1,3})\s*%\s*(.+)$/i);

  let remainingPercent = null;
  let usagePercent = null;
  let resetLabel = null;

  if (leftMatch) {
    remainingPercent = Math.max(0, Math.min(100, Number(leftMatch[1])));
    usagePercent = 100 - remainingPercent;
  } else if (usedMatch) {
    usagePercent = Math.max(0, Math.min(100, Number(usedMatch[1])));
    remainingPercent = 100 - usagePercent;
  } else if (genericPercentMatch) {
    // "/status" popup shows "Rate limits remaining", so plain "%" is treated as remaining.
    remainingPercent = Math.max(0, Math.min(100, Number(genericPercentMatch[1])));
    usagePercent = 100 - remainingPercent;
  }

  if (resetParenMatch) {
    resetLabel = resetParenMatch[1].trim();
  } else if (compactResetMatch) {
    const trailing = String(compactResetMatch[2] || '').trim();
    if (trailing && !/left|used/i.test(trailing)) {
      resetLabel = trailing;
    }
  }

  const isLimitedByText = /(limit reached|rate limit reached|exceeded|blocked|no .*left|\b0\s*%\s*left\b)/i.test(normalized);
  const isLimited = isLimitedByText || remainingPercent === 0;

  return {
    status: isLimited ? 'limited' : 'ok',
    usagePercent,
    remainingPercent,
    resetLabel,
    line: normalized
  };
}

function getFileMtimeIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function parseCodexQuota(projectPath) {
  const logDir = path.join(projectPath, '.ralph', 'logs');
  const ralphLog = tailFile(path.join(logDir, 'ralph.log'), 2000);
  const stderrFiles = listRecentLogFilesByPrefix(logDir, 'codex_stderr_', 8);
  const stderrText = stderrFiles.map((filePath) => tailFile(filePath, 120)).join('\n');
  const corpus = `${ralphLog}\n${stderrText}`;
  const lines = corpus.split('\n').filter(Boolean);

  const fiveHourPatterns = [
    /5[\s-]?hour/i,
    /usage limit reached/i,
    /api usage limit/i,
    /try again in about an hour/i
  ];
  const weeklyPatterns = [
    /weekly/i,
    /week(?:ly)?\s+limit/i,
    /7[\s-]?day/i
  ];

  const lastMatch = (patterns) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (patterns.some((pattern) => pattern.test(lines[i]))) {
        return lines[i];
      }
    }
    return '';
  };

  const fiveHourLine = lastMatch(fiveHourPatterns);
  const weeklyLine = lastMatch(weeklyPatterns);

  const statusFromSignal = (line) => {
    if (!line) return 'unknown';
    if (/(limit reached|rate limit reached|exceeded|blocked|try again)/i.test(line)) return 'limited';
    return 'ok';
  };

  return {
    fiveHour: {
      status: statusFromSignal(fiveHourLine),
      lastSignal: fiveHourLine || '',
      source: fiveHourLine ? 'ralph/codex logs' : 'no recent limit signals'
    },
    weekly: {
      status: statusFromSignal(weeklyLine),
      lastSignal: weeklyLine || '',
      source: weeklyLine ? 'ralph/codex logs' : 'Codex CLI does not expose weekly usage directly in normal flow'
    },
    updatedAt: new Date().toISOString()
  };
}

function parseCodexStatusSnapshotText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return null;
  }

  const lines = text
    .split('\n')
    .map((line) => normalizeStatusLine(line))
    .filter(Boolean);
  const findLine = (patterns) =>
    lines.find((line) => patterns.some((pattern) => pattern.test(line))) || '';

  const fiveHourLine = findLine([/5[\s-]?hour/i, /\b5h\b/i]);
  const weeklyLine = findLine([/weekly/i, /\bweek\b/i, /7[\s-]?day/i]);
  const fiveHour = parseLimitLine(fiveHourLine) || { status: 'unknown', usagePercent: null, remainingPercent: null, line: '' };
  const weekly = parseLimitLine(weeklyLine) || { status: 'unknown', usagePercent: null, remainingPercent: null, line: '' };

  return {
    fiveHour,
    weekly,
    updatedAt: new Date().toISOString(),
    raw: stripAnsi(text)
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/processes', (_req, res) => {
  try {
    const output = execSync("ps -axo pid,ppid,etime,command | grep -E 'ralph_loop.sh|ralph --|codex exec' | grep -v grep", {
      encoding: 'utf8'
    });

    const processes = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          pid: Number(parts[0]),
          ppid: Number(parts[1]),
          etime: parts[2],
          command: parts.slice(3).join(' ')
        };
      });

    res.json({ processes });
  } catch {
    res.json({ processes: [] });
  }
});

app.post('/api/run', (req, res) => {
  const {
    projectPath,
    args = '--sandbox workspace-write --full-auto --timeout 20 --calls 30 --verbose',
    ralphScript = DEFAULT_RALPH_SCRIPT
  } = req.body || {};

  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'projectPath invalido' });
  }

  const logDir = path.join(projectPath, '.ralph', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `ui_run_${ts}.log`);

  const command = `${ralphScript} ${args} > '${logFile}' 2>&1`;
  const child = spawn('bash', ['-lc', command], {
    cwd: projectPath,
    detached: true,
    stdio: 'ignore'
  });

  child.unref();

  return res.json({ started: true, pid: child.pid, logFile, command });
});

app.post('/api/stop', (req, res) => {
  const pid = Number(req.body?.pid);
  if (!pid) {
    return res.status(400).json({ error: 'pid invalido' });
  }

  try {
    process.kill(pid, 'SIGTERM');
    return res.json({ stopped: true, pid });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/project-status', (req, res) => {
  const projectPath = req.query.projectPath;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'projectPath invalido' });
  }

  const statusFile = path.join(projectPath, '.ralph', 'status.json');
  const logFile = path.join(projectPath, '.ralph', 'logs', 'ralph.log');
  const fixPlanFile = path.join(projectPath, '.ralph', 'fix_plan.md');
  const codexStatusSnapshotFile = path.join(projectPath, '.ralph', 'codex_status_snapshot.txt');

  const status = safeReadJson(statusFile);
  const fixPlan = fs.existsSync(fixPlanFile) ? fs.readFileSync(fixPlanFile, 'utf8') : '';
  const logs = tailFile(logFile, 100);
  const codexQuota = parseCodexQuota(projectPath);
  const codexStatusSnapshotRaw = safeReadText(codexStatusSnapshotFile);
  const codexStatusSnapshot = parseCodexStatusSnapshotText(codexStatusSnapshotRaw);
  const snapshotCapturedAt = getFileMtimeIso(codexStatusSnapshotFile);
  if (codexStatusSnapshot && snapshotCapturedAt) {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(snapshotCapturedAt)) / 1000));
    codexStatusSnapshot.capturedAt = snapshotCapturedAt;
    codexStatusSnapshot.ageSeconds = ageSeconds;
    codexStatusSnapshot.isStale = ageSeconds > 300;
  }

  res.json({ status, logs, fixPlan, codexQuota, codexStatusSnapshot });
});

app.post('/api/codex-status-snapshot', (req, res) => {
  const projectPath = req.body?.projectPath;
  const snapshotText = req.body?.snapshotText || '';
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'projectPath invalido' });
  }

  const ralphDir = path.join(projectPath, '.ralph');
  fs.mkdirSync(ralphDir, { recursive: true });
  const snapshotFile = path.join(ralphDir, 'codex_status_snapshot.txt');
  fs.writeFileSync(snapshotFile, String(snapshotText), 'utf8');
  const parsed = parseCodexStatusSnapshotText(snapshotText);
  const capturedAt = getFileMtimeIso(snapshotFile);
  if (parsed && capturedAt) {
    parsed.capturedAt = capturedAt;
    parsed.ageSeconds = 0;
    parsed.isStale = false;
  }

  return res.json({
    saved: true,
    file: snapshotFile,
    parsed
  });
});

app.post('/api/codex-status-snapshot/clear', (req, res) => {
  const projectPath = req.body?.projectPath;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'projectPath invalido' });
  }
  const snapshotFile = path.join(projectPath, '.ralph', 'codex_status_snapshot.txt');
  try {
    if (fs.existsSync(snapshotFile)) {
      fs.unlinkSync(snapshotFile);
    }
    return res.json({ cleared: true, file: snapshotFile });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'falha ao limpar snapshot' });
  }
});

app.get('/api/export-diagnostics', (req, res) => {
  const projectPath = req.query.projectPath;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'projectPath invalido' });
  }

  const ralphDir = path.join(projectPath, '.ralph');
  const logDir = path.join(ralphDir, 'logs');
  const statusFile = path.join(ralphDir, 'status.json');
  const fixPlanFile = path.join(ralphDir, 'fix_plan.md');
  const sessionFile = path.join(ralphDir, '.codex_session_id');
  const responseAnalysisFile = path.join(ralphDir, '.response_analysis');
  const recentLogFiles = listRecentLogFiles(logDir, 10);

  const diagnostics = {
    exportedAt: new Date().toISOString(),
    projectPath,
    environment: {
      node: process.version,
      platform: process.platform
    },
    status: safeReadJson(statusFile),
    fixPlan: safeReadText(fixPlanFile),
    sessionId: safeReadText(sessionFile).trim(),
    responseAnalysis: safeReadText(responseAnalysisFile),
    codexQuota: parseCodexQuota(projectPath),
    codexStatusSnapshot: parseCodexStatusSnapshotText(safeReadText(path.join(ralphDir, 'codex_status_snapshot.txt'))),
    processes: [],
    logs: {
      ralphTail100: tailFile(path.join(logDir, 'ralph.log'), 100),
      recentFiles: {}
    }
  };

  try {
    const output = execSync("ps -axo pid,ppid,etime,command | grep -E 'ralph_loop.sh|ralph --|codex exec' | grep -v grep", {
      encoding: 'utf8'
    });

    diagnostics.processes = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          pid: Number(parts[0]),
          ppid: Number(parts[1]),
          etime: parts[2],
          command: parts.slice(3).join(' ')
        };
      });
  } catch {
    diagnostics.processes = [];
  }

  recentLogFiles.forEach((filePath) => {
    diagnostics.logs.recentFiles[path.basename(filePath)] = tailFile(filePath, 120);
  });

  const fileName = `ralph-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${fileName}\"`);
  return res.send(JSON.stringify(diagnostics, null, 2));
});

app.listen(PORT, () => {
  console.log(`Ralph Control API listening on http://localhost:${PORT}`);
});
