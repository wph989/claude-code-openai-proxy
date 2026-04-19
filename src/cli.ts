#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { settings } from './config.js';
import { startServer } from './server.js';
import { buildDefaultRuntimeConfig } from './services/runtime-config.js';
import { log } from './utils/logger.js';
import { checkExistingProcess, stopProcess, getStatus, writeProcessInfo, removeProcessInfo, openAdminUI } from './utils/pid.js';
import process from 'node:process';

const program = new Command();

program
  .name('ccop')
  .description('Claude Code 多供应商代理（TypeScript 版）')
  .version('0.1.0');

program
  .command('start')
  .description('启动代理服务')
  .option('--host <host>', '监听地址', settings.host)
  .option('--port <port>', '监听端口', String(settings.port))
  .option('--config <path>', '运行时模型配置文件路径', settings.configFile)
  .option('--dev', '强制开发模式（使用本地目录配置）', false)
  .option('-d, --daemon', '后台运行（守护进程模式）', false)
  .action(async (options) => {
    const port = Number(options.port || settings.port);
    const host = options.host || settings.host;

    // check if already running
    const existingInfo = await checkExistingProcess();
    if (existingInfo) {
      log('warn', '服务已在运行', { port: existingInfo.port, pid: existingInfo.pid });
      console.log(`服务已在运行 (Port: ${existingInfo.port}, PID: ${existingInfo.pid})`);
      process.exit(1);
    }

    if (options.daemon) {
      // start in background
      const args = ['start', ...process.argv.slice(3).filter(arg => arg !== '-d' && arg !== '--daemon')];
      const child = spawn(process.argv0, [process.argv[1], ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      console.log(`服务已在后台启动`);
      log('info', '服务已在后台启动', { pid: child.pid, port, host });
      process.exit(0);
    } else {
      await writeProcessInfo({ pid: process.pid, port, host });

      // cleanup on exit
      process.on('exit', () => { void removeProcessInfo(); });
      process.on('SIGINT', () => { void removeProcessInfo(); process.exit(0); });
      process.on('SIGTERM', () => { void removeProcessInfo(); process.exit(0); });

      await startServer({
        host,
        port: Number.isFinite(port) ? port : settings.port,
        configPath: options.config || settings.configFile
      });
    }
  });

program
  .command('stop')
  .description('停止代理服务（自动读取端口）')
  .action(async () => {
    const result = await stopProcess();
    console.log(result);
    log('info', result);
  });

program
  .command('status')
  .description('查看服务运行状态')
  .action(async () => {
    const status = await getStatus();
    if (status.running) {
      console.log(`✓ 服务运行中 - Port: ${status.port}, PID: ${status.pid}`);
      log('info', '服务运行中', { port: status.port, pid: status.pid });
    } else {
      console.log('✗ 服务未运行');
    }
  });

program
  .command('ui')
  .description('打开管理后台界面（自动检测浏览器）')
  .action(async () => {
    try {
      const url = await openAdminUI();
      console.log(`管理界面地址: ${url}`);
      log('info', '打开管理界面', { url });

      // try to open browser (cross-platform)
      const { exec, spawn } = await import('node:child_process');
      const platform = process.platform;

      if (platform === 'win32') {
        // Windows: 使用 spawn 启动浏览器
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      } else if (platform === 'darwin') {
        // macOS
        exec(`open "${url}"`, () => {});
      } else {
        // Linux
        exec(`xdg-open "${url}"`, (error) => {
          if (error) {
            console.log('请手动在浏览器中打开上述地址');
          }
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`错误: ${msg}`);
      process.exit(1);
    }
  });

import { USER_CONFIG_DIR } from './config.js';

program
  .command('init-config')
  .description('初始化配置文件到 ~/.ccop/')
  .option('--config <path>', '输出路径（默认 ~/.ccop/runtime_models.json）')
  .option('--force', '覆盖已存在的文件', false)
  .action(async (options) => {
    const output = options.config ? path.resolve(options.config) : join(USER_CONFIG_DIR, 'runtime_models.json');
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
