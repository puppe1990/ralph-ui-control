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

  const status = safeReadJson(statusFile);
  const fixPlan = fs.existsSync(fixPlanFile) ? fs.readFileSync(fixPlanFile, 'utf8') : '';
  const logs = tailFile(logFile, 100);

  res.json({ status, logs, fixPlan });
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
