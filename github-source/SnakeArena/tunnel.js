'use strict';

/**
 * 公网隧道管理：通过本机 OpenSSH 连接 localhost.run 的免费 SSH 隧道。
 * 只需要出站 SSH（默认 22 端口），不依赖路由器端口映射。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findSsh() {
  if (process.platform === 'win32') {
    const builtin = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(builtin)) return builtin;
    return 'ssh';
  }
  for (const candidate of ['/usr/bin/ssh', '/usr/local/bin/ssh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ssh';
}

class TunnelManager {
  constructor(options = {}) {
    this.port = options.port;
    this.status = 'idle'; // idle | starting | running | error
    this.url = null;
    this.error = null;
    this.startedAt = 0;
    this.child = null;
    this.buffer = '';
    this.timeout = null;
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.stopping = false;
    this.sshPath = findSsh();
  }

  snapshot() {
    return {
      state: this.status,
      url: this.url,
      error: this.error,
      startedAt: this.startedAt,
      provider: 'localhost.run',
      available: fs.existsSync(this.sshPath) || this.sshPath === 'ssh'
    };
  }

  start() {
    if (this.status === 'running') return Promise.resolve(this.snapshot());
    if (this.startPromise) return this.startPromise;

    this.status = 'starting';
    this.url = null;
    this.error = null;
    this.startedAt = 0;
    this.stopping = false;
    this.buffer = '';

    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });

    const knownHosts = path.join(os.tmpdir(), 'snake-arena-known_hosts');
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'RequestTTY=no',
      '-o', 'BatchMode=yes',
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'ConnectTimeout=15',
      '-R', `80:127.0.0.1:${this.port}`,
      'nokey@localhost.run'
    ];

    let child;
    try {
      child = spawn(this.sshPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      this.fail('无法启动 ssh：' + error.message);
      return this.startPromise;
    }

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onOutput(chunk));
    child.stderr.on('data', (chunk) => this.onOutput(chunk));
    child.on('error', (error) => this.fail('ssh 启动失败：' + error.message));
    child.on('exit', (code) => this.onExit(child, code));

    this.timeout = setTimeout(() => {
      if (this.status === 'starting') {
        this.fail('建立公网隧道超时，请检查网络后重试。');
      }
    }, 30000);

    return this.startPromise;
  }

  onOutput(chunk) {
    if (!chunk) return;
    const combined = this.buffer + chunk;
    if (this.status === 'starting') {
      const match = combined.match(/https:\/\/[a-z0-9-]+\.lhr\.life/i);
      if (match) {
        this.buffer = combined.slice(-4096);
        this.onUrl(match[0]);
        return;
      }
    }
    this.buffer = combined.slice(-4096);
  }

  onUrl(url) {
    if (this.status !== 'starting') return;
    this.clearTimer();
    this.status = 'running';
    this.url = url;
    this.startedAt = Date.now();
    this.error = null;

    if (this.resolveStart) this.resolveStart(this.snapshot());
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
  }

  fail(message) {
    if (this.status === 'idle') return;
    this.clearTimer();
    this.killChild();
    this.status = 'error';
    this.error = message;
    this.url = null;
    this.startedAt = 0;

    if (this.rejectStart) this.rejectStart(new Error(message));
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
  }

  onExit(child, code) {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) {
      this.stopping = false;
      this.status = 'idle';
      return;
    }
    if (this.status === 'starting') {
      this.fail('公网隧道进程提前退出（code ' + code + '）。请检查本机 OpenSSH 与网络。');
      return;
    }
    if (this.status === 'running') {
      this.status = 'error';
      this.error = '公网隧道已断开（code ' + code + '），请重新生成。';
      this.url = null;
      this.startedAt = 0;
    }
  }

  async stop() {
    this.stopping = true;
    this.clearTimer();
    this.killChild();
    if (this.rejectStart) this.rejectStart(new Error('公网隧道已取消。'));
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.status = 'idle';
    this.url = null;
    this.error = null;
    this.startedAt = 0;
  }

  clearTimer() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  killChild() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  TunnelManager,
  findSsh
};
