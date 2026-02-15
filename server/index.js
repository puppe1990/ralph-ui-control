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

app.listen(PORT, () => {
  console.log(`Ralph Control API listening on http://localhost:${PORT}`);
});
