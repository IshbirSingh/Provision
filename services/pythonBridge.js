// Runs python/main.py as a child process. Input is sent as JSON on stdin and
// the result is read as JSON from stdout. Python never touches data.json.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'python', 'main.py');
const DEFAULT_TIMEOUT_MS = 120000;

function resolvePython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venv = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

class PythonError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function runPython(task, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePython(), [MAIN], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new PythonError(`Python task "${task}" timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new PythonError(`Could not start Python: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new PythonError(`Python task "${task}" returned invalid JSON (exit ${code})`, { stdout, stderr }));
      }
      if (!parsed.ok) {
        return reject(new PythonError(parsed.error || `Python task "${task}" failed`, { stderr, trace: parsed.trace }));
      }
      resolve(parsed.result);
    });

    child.stdin.end(JSON.stringify({ task, payload }));
  });
}

module.exports = { runPython, resolvePython, PythonError };
