#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { settings } from './config.js';
import { startServer } from './server.js';
import { buildDefaultRuntimeConfig } from './services/runtime-config.js';
import { log } from './utils/logger.js';

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
  .action(async (options) => {
    const port = Number(options.port || settings.port);
    await startServer({
      host: options.host || settings.host,
      port: Number.isFinite(port) ? port : settings.port,
      configPath: options.config || settings.configFile
    });
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
