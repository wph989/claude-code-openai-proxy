#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { settings } from './config.js';
import { startServer } from './server.js';
import { buildDefaultRuntimeConfig } from './services/runtime-config.js';
import { log } from './utils/logger.js';
import { checkExistingProcess, stopProcess, getStatus, writePidFile, removePidFile } from './utils/pid.js';
import process from 'node:process';

const program = new Command();

program
  .name('claude-code-gateway-proxy')
  .description('Claude Code 多供应商代理（TypeScript 版）')
  .version('0.1.0');

program
  .command('start')
  .description('启动代理服务')
  .option('--host <host>', '监听地址', settings.host)
  .option('--port <port>', '监听端口', String(settings.port))
  .option('--config <path>', '运行时模型配置文件路径', settings.configFile)
  .option('-d, --daemon', '后台运行（守护进程模式）', false)
  .action(async (options) => {
    const port = Number(options.port || settings.port);

    // check if already running
    const existingPid = await checkExistingProcess(port);
    if (existingPid) {
      log('warn', '服务已在运行', { port, pid: existingPid });
      console.log(`服务已在运行 (PID: ${existingPid})`);
      process.exit(1);
    }

    if (options.daemon) {
      // start in background
      const args = process.argv.slice(2).filter(arg => arg !== '-d' && arg !== '--daemon');
      const child = spawn(process.argv0, [process.argv[1], ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      console.log(`服务已在后台启动 (PID: ${child.pid})`);
      log('info', '服务已在后台启动', { pid: child.pid, port });
      process.exit(0);
    } else {
      await writePidFile(port);

      // cleanup pid file on exit
      process.on('exit', () => {
        void removePidFile(port);
      });
      process.on('SIGINT', () => {
        void removePidFile(port);
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        void removePidFile(port);
        process.exit(0);
      });

      await startServer({
        host: options.host || settings.host,
        port: Number.isFinite(port) ? port : settings.port,
        configPath: options.config || settings.configFile
      });
    }
  });

program
  .command('stop')
  .description('停止代理服务')
  .option('-p, --port <port>', '监听的端口', String(settings.port))
  .action(async (options) => {
    const port = Number(options.port || settings.port);
    const result = await stopProcess(port);
    console.log(result);
    log('info', result);
  });

program
  .command('status')
  .description('查看服务运行状态')
  .option('-p, --port <port>', '监听的端口', String(settings.port))
  .action((options) => {
    const port = Number(options.port || settings.port);
    const status = getStatus(port);
    if (status.running) {
      console.log(`✓ 服务运行中 - Port: ${status.port}, PID: ${status.pid}`);
      log('info', '服务运行中', { port: status.port, pid: status.pid });
    } else {
      console.log(`✗ 服务未运行 - Port: ${status.port}`);
    }
  });

program
  .command('init-config')
  .description('在当前目录初始化 runtime_models.json')
  .option('--config <path>', '输出路径', './runtime_models.json')
  .option('--force', '覆盖已存在的文件', false)
  .action(async (options) => {
    const output = path.resolve(options.config || './runtime_models.json');
    const content = JSON.stringify(buildDefaultRuntimeConfig(), null, 2) + '\n';
    try {
      await writeFile(output, content, { encoding: 'utf-8', flag: options.force ? 'w' : 'wx' });
      log('info', '初始化配置文件完成', { output });
    } catch (error) {
      log('error', '初始化配置文件失败', { output, error });
      process.exitCode = 1;
    }
  });

void program.parseAsync(process.argv);
