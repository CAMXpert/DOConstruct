import { spawn } from 'node:child_process';
import path from 'node:path';

export class BackendError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

export function runProcess(command, argv, { cwd, input = '', signal, onLog, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', done = false, stopReason = null, stopping;
    const child = spawn(command, argv, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    // A shell can own script children; killing only the shell leaves those tasks running.
    const stop = reason => {
      if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      stopReason = reason;
      if (process.platform === 'win32') {
        stopping = new Promise(resolve => {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill(); resolve(); });
          killer.once('close', code => { if (code && child.exitCode === null && child.signalCode === null) child.kill(); resolve(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        stopping = Promise.resolve();
      }
    };
    const abort = () => stop('CANCELED');
    const timer = setTimeout(() => { stderr += '\nProcess timed out.'; stop('PROCESS_TIMEOUT'); }, timeoutMs);
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', text => {
        if (name === 'stdout') stdout += text; else stderr += text;
        onLog?.(name, text);
        if (stdout.length + stderr.length > 64 * 1024 * 1024) { stderr += '\nOutput exceeds 64 MiB.'; stop('PROCESS_OUTPUT_LIMIT'); }
      });
    }
    child.once('error', error => finish(new BackendError('PROCESS_START', error.message, { command, argv, cwd, systemCode: error.code, stdout, stderr })));
    child.once('close', async (code, sig) => {
      await stopping;
      const details = { command, argv, cwd, stdout, stderr, exitCode: code, signal: sig };
      if (signal?.aborted) return finish(new BackendError('CANCELED', 'Task canceled.', details));
      if (stopReason) return finish(new BackendError(stopReason, stopReason === 'PROCESS_TIMEOUT' ? 'Process timed out.' : 'Process output exceeded 64 MiB.', details));
      if (code !== 0) return finish(new BackendError('PROCESS_FAILED', `${command} exited with ${code ?? sig}.`, details));
      finish(null, { stdout, stderr, exitCode: code, signal: sig });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
