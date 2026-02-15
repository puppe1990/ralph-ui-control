const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

  const resetEpoch = Number(resetLabel);
  if (Number.isFinite(resetEpoch) && resetEpoch > 0) {
    resetLabel = formatResetLabelFromEpoch(resetEpoch);
  }

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

function formatResetLabelFromEpoch(resetEpochSeconds) {
  const epoch = Number(resetEpochSeconds);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const resetDate = new Date(epoch * 1000);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone
  }).format(resetDate);
}

function getQuotaStatusFromRemaining(remainingPercent) {
  if (typeof remainingPercent !== 'number' || Number.isNaN(remainingPercent)) return 'unknown';
  if (remainingPercent <= 0) return 'limited';
  if (remainingPercent <= 10) return 'warning';
  return 'ok';
}

function parseProcessTable(output) {
  return String(output || '')
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
}

function listRuntimeProcesses() {
  try {
    const output = execSync("ps -axo pid,ppid,etime,command | grep -E 'ralph_loop.sh|ralph --|codex exec' | grep -v grep", {
      encoding: 'utf8'
    });
    return parseProcessTable(output);
  } catch {
    return [];
  }
}

function getStatusAgeSeconds(status) {
  const ts = status?.timestamp;
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function buildEffectiveQuota(codexStatusSnapshot, codexQuota, sessionRateLimits, statusEffectiveQuota) {
  const normalizeStatusQuota = (quotaObj, source = 'status_json') => {
    if (!quotaObj || typeof quotaObj !== 'object') return null;
    const five = quotaObj.five_hour || quotaObj.fiveHour || {};
    const weekly = quotaObj.weekly || {};
    const hasNumbers =
      typeof five.remaining_percent === 'number' ||
      typeof five.remainingPercent === 'number' ||
      typeof weekly.remaining_percent === 'number' ||
      typeof weekly.remainingPercent === 'number';
    if (!hasNumbers) return null;
    return {
      fiveHour: {
        status: five.status || 'unknown',
        remainingPercent: five.remainingPercent ?? five.remaining_percent ?? null,
        usagePercent: five.usagePercent ?? five.used_percent ?? null,
        resetLabel: five.resetLabel || five.reset_label_local || formatResetLabelFromEpoch(five.resets_at_epoch),
        line: ''
      },
      weekly: {
        status: weekly.status || 'unknown',
        remainingPercent: weekly.remainingPercent ?? weekly.remaining_percent ?? null,
        usagePercent: weekly.usagePercent ?? weekly.used_percent ?? null,
        resetLabel: weekly.resetLabel || weekly.reset_label_local || formatResetLabelFromEpoch(weekly.resets_at_epoch),
        line: ''
      },
      updatedAt: new Date().toISOString(),
      source: quotaObj.source || source
    };
  };

  const normalizedStatusQuota = normalizeStatusQuota(statusEffectiveQuota);
  if (normalizedStatusQuota) {
    return normalizedStatusQuota;
  }

  const snapshotHasNumbers =
    codexStatusSnapshot &&
    (typeof codexStatusSnapshot?.fiveHour?.remainingPercent === 'number' ||
      typeof codexStatusSnapshot?.weekly?.remainingPercent === 'number');

  if (snapshotHasNumbers && !codexStatusSnapshot?.isStale) {
    return {
      ...codexStatusSnapshot,
      source: codexStatusSnapshot?.source || 'snapshot'
    };
  }

  if (sessionRateLimits) {
    return {
      fiveHour: {
        status: getQuotaStatusFromRemaining(sessionRateLimits.fiveHour?.remainingPercent),
        remainingPercent: sessionRateLimits.fiveHour?.remainingPercent ?? null,
        usagePercent: sessionRateLimits.fiveHour?.usagePercent ?? null,
        resetLabel: sessionRateLimits.fiveHour?.resetLabel ?? null,
        line: ''
      },
      weekly: {
        status: getQuotaStatusFromRemaining(sessionRateLimits.weekly?.remainingPercent),
        remainingPercent: sessionRateLimits.weekly?.remainingPercent ?? null,
        usagePercent: sessionRateLimits.weekly?.usagePercent ?? null,
        resetLabel: sessionRateLimits.weekly?.resetLabel ?? null,
        line: ''
      },
      updatedAt: new Date().toISOString(),
      source: 'codex_sessions'
    };
  }

  if (codexQuota) {
    return {
      fiveHour: codexQuota.fiveHour || { status: 'unknown' },
      weekly: codexQuota.weekly || { status: 'unknown' },
      updatedAt: codexQuota.updatedAt || new Date().toISOString(),
      source: 'heuristics_logs'
    };
  }

  return {
    fiveHour: { status: 'unknown' },
    weekly: { status: 'unknown' },
    updatedAt: new Date().toISOString(),
    source: 'none'
  };
}

function listRecentCodexSessionFiles(limit = 30) {
  const codexRoot = path.join(os.homedir(), '.codex');
  const sessionRoots = [path.join(codexRoot, 'sessions'), path.join(codexRoot, 'archived_sessions')];
  const files = [];

  const walk = (dirPath, depth = 0) => {
    if (!dirPath || !fs.existsSync(dirPath) || depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        try {
          const mtimeMs = fs.statSync(fullPath).mtimeMs;
          files.push({ fullPath, mtimeMs });
        } catch {
          // Ignore unreadable files
        }
      }
    }
  };

  sessionRoots.forEach((rootPath) => walk(rootPath));
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((f) => f.fullPath);
}

function readLatestRateLimitsFromCodexSessions() {
  const candidates = listRecentCodexSessionFiles(30);
  for (const filePath of candidates) {
    const tail = tailFile(filePath, 600);
    const lines = tail.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let json = null;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json?.type !== 'event_msg' || json?.payload?.type !== 'token_count' || !json?.payload?.rate_limits) {
        continue;
      }
      const primary = json.payload.rate_limits.primary;
      const secondary = json.payload.rate_limits.secondary;
      if (!primary && !secondary) continue;

      const primaryUsed = Number(primary?.used_percent);
      const secondaryUsed = Number(secondary?.used_percent);
      const primaryRemaining = Number.isFinite(primaryUsed) ? Math.max(0, Math.min(100, Math.round(100 - primaryUsed))) : null;
      const secondaryRemaining = Number.isFinite(secondaryUsed) ? Math.max(0, Math.min(100, Math.round(100 - secondaryUsed))) : null;

      return {
        sourceFile: filePath,
        eventTimestamp: json.timestamp || null,
        fiveHour: {
          remainingPercent: primaryRemaining,
          usagePercent: Number.isFinite(primaryUsed) ? Math.round(primaryUsed) : null,
          resetLabel: formatResetLabelFromEpoch(primary?.resets_at)
        },
        weekly: {
          remainingPercent: secondaryRemaining,
          usagePercent: Number.isFinite(secondaryUsed) ? Math.round(secondaryUsed) : null,
          resetLabel: formatResetLabelFromEpoch(secondary?.resets_at)
        }
      };
    }
  }
  return null;
}

function buildSnapshotTextFromRateLimits(rateLimits) {
  if (!rateLimits) return '';
  const five = rateLimits.fiveHour || {};
  const week = rateLimits.weekly || {};
  const fivePart =
    five.remainingPercent != null
      ? `5h ${five.remainingPercent}%${five.resetLabel ? ` ${five.resetLabel}` : ''}`
      : '5h --';
  const weekPart =
    week.remainingPercent != null
      ? `Weekly ${week.remainingPercent}%${week.resetLabel ? ` ${week.resetLabel}` : ''}`
      : 'Weekly --';
  return `Rate limits remaining\n${fivePart}\n${weekPart}`;
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

  const kvMatches = {};
  text
    .split('\n')
    .map((line) => normalizeStatusLine(line))
    .forEach((line) => {
      const kv = line.match(/^([a-zA-Z0-9_]+)=(.*)$/);
      if (!kv) return;
      kvMatches[kv[1]] = String(kv[2] || '').trim();
    });

  if (Object.keys(kvMatches).length > 0) {
    const parseNum = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };
    const normalizeStatus = (remaining) => {
      if (remaining == null) return 'unknown';
      if (remaining <= 0) return 'limited';
      if (remaining <= 10) return 'warning';
      return 'ok';
    };

    const fiveRemaining = parseNum(kvMatches['5h_remaining_percent']);
    const fiveUsed = parseNum(kvMatches['5h_used_percent']);
    const weeklyRemaining = parseNum(kvMatches['weekly_remaining_percent']);
    const weeklyUsed = parseNum(kvMatches['weekly_used_percent']);

    const fiveResetRaw = kvMatches['5h_resets_at'] || null;
    const weeklyResetRaw = kvMatches['weekly_resets_at'] || null;
    const fiveReset = fiveResetRaw ? formatResetLabelFromEpoch(fiveResetRaw) || fiveResetRaw : null;
    const weeklyReset = weeklyResetRaw ? formatResetLabelFromEpoch(weeklyResetRaw) || weeklyResetRaw : null;

    return {
      fiveHour: {
        status: normalizeStatus(fiveRemaining),
        usagePercent: fiveUsed,
        remainingPercent: fiveRemaining,
        resetLabel: fiveReset,
        line: kvMatches['5h_human'] || ''
      },
      weekly: {
        status: normalizeStatus(weeklyRemaining),
        usagePercent: weeklyUsed,
        remainingPercent: weeklyRemaining,
        resetLabel: weeklyReset,
        line: kvMatches['weekly_human'] || ''
      },
      updatedAt: new Date().toISOString(),
      source: kvMatches.source || 'snapshot_kv',
      raw: stripAnsi(text)
    };
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
  res.json({ processes: listRuntimeProcesses() });
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
  const processes = listRuntimeProcesses();
  const codexStatusSnapshotRaw = safeReadText(codexStatusSnapshotFile);
  let codexStatusSnapshot = parseCodexStatusSnapshotText(codexStatusSnapshotRaw);
  const snapshotCapturedAt = getFileMtimeIso(codexStatusSnapshotFile);
  const sessionRateLimits = readLatestRateLimitsFromCodexSessions();
  const statusAgeSeconds = getStatusAgeSeconds(status);

  if (codexStatusSnapshot && snapshotCapturedAt) {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(snapshotCapturedAt)) / 1000));
    codexStatusSnapshot.capturedAt = snapshotCapturedAt;
    codexStatusSnapshot.ageSeconds = ageSeconds;
    codexStatusSnapshot.isStale = ageSeconds > 300;
  }

  const codexQuotaEffective = buildEffectiveQuota(codexStatusSnapshot, codexQuota, sessionRateLimits, status?.codex_quota_effective);
  const runtime = {
    processesCount: processes.length,
    statusAgeSeconds,
    statusFresh: typeof statusAgeSeconds === 'number' ? statusAgeSeconds <= 30 : false,
    runtimeHealthy:
      processes.length > 0 &&
      status != null &&
      ['running', 'paused', 'retrying'].includes(String(status.status || '').toLowerCase()) &&
      (typeof statusAgeSeconds === 'number' ? statusAgeSeconds <= 30 : false)
  };

  res.json({ status, logs, fixPlan, codexQuota, codexStatusSnapshot, codexQuotaEffective, runtime, processes });
});

app.post('/api/codex-status-snapshot', (req, res) => {
  const projectPath = req.body?.projectPath;
  const snapshotText = req.body?.snapshotText || '';
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'projectPath invalido' });
  }

  const ralphDir = path.join(projectPath, '.ralph');
  fs.mkdirSync(ralphDir, { recursive: true });
  const normalizedInput = String(snapshotText || '').trim();
  let snapshotToSave = normalizedInput;

  if (!normalizedInput || /^\/status\s*$/i.test(normalizedInput)) {
    const latest = readLatestRateLimitsFromCodexSessions();
    if (latest) {
      snapshotToSave = buildSnapshotTextFromRateLimits(latest);
    } else if (!normalizedInput) {
      return res.status(400).json({ error: 'cole a saida do /status ou rode novamente quando houver snapshot local' });
    }
  }

  const snapshotFile = path.join(ralphDir, 'codex_status_snapshot.txt');
  fs.writeFileSync(snapshotFile, String(snapshotToSave), 'utf8');
  const parsed = parseCodexStatusSnapshotText(snapshotToSave);
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
    codexQuotaEffective: null,
    processes: [],
    logs: {
      ralphTail100: tailFile(path.join(logDir, 'ralph.log'), 100),
      recentFiles: {}
    }
  };

  diagnostics.processes = listRuntimeProcesses();
  diagnostics.codexQuotaEffective = buildEffectiveQuota(
    diagnostics.codexStatusSnapshot,
    diagnostics.codexQuota,
    readLatestRateLimitsFromCodexSessions(),
    diagnostics.status?.codex_quota_effective
  );

  recentLogFiles.forEach((filePath) => {
    diagnostics.logs.recentFiles[path.basename(filePath)] = tailFile(filePath, 120);
  });

  const fileName = `ralph-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${fileName}\"`);
  return res.send(JSON.stringify(diagnostics, null, 2));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ralph Control API listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  normalizeStatusLine,
  parseLimitLine,
  parseCodexStatusSnapshotText,
  buildEffectiveQuota,
  formatResetLabelFromEpoch
};
