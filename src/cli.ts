#!/usr/bin/env node
import path, { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { settings } from './config.js';
import { startServer } from './server.js';
import { buildDefaultRuntimeConfig } from './services/runtime-config.js';
import { SqliteConfigRepository } from './services/config/sqlite-config-repository.js';
import {
  autoMigrateJsonToSqlite,
  migrateJsonToSqlite,
} from './services/config/json-to-sqlite-migration.js';
import { log } from './utils/logger.js';
import { checkExistingProcess, stopProcess, getStatus, writeProcessInfo, removeProcessInfo, openAdminUI } from './utils/pid.js';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// 动态读取 package.json 版本号
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const program = new Command();

program
  .name('ccop')
  .description('Claude Code 多供应商代理（TypeScript 版）')
  .version(pkg.version);

program
  .command('start')
  .description('启动代理服务')
  .option('--host <host>', '监听地址', settings.host)
  .option('--port <port>', '监听端口', String(settings.port))
  .option('--sqlite-file <path>', 'SQLite 数据库路径', settings.sqliteFile)
  .option('--migrate-from-json <path>', '覆盖默认的旧 JSON 自动迁移源')
  .option('--dev', '强制开发模式（使用本地目录配置）', false)
  .option('-d, --daemon', '后台运行（守护进程模式）', false)
  .option('-c, --cluster [workers]', '启用集群模式；多 Worker 要求 SQLite', false)
  .action(async (options) => {
    const port = Number(options.port || settings.port);
    const host = options.host || settings.host;
    const sqlitePath = path.resolve(options.sqliteFile || settings.sqliteFile);

    // check if already running
    const existingInfo = await checkExistingProcess();
    if (existingInfo) {
      log('warn', '服务已在运行', { port: existingInfo.port, pid: existingInfo.pid });
      console.log(`服务已在运行 (Port: ${existingInfo.port}, PID: ${existingInfo.pid})`);
      process.exit(1);
    }

    try {
      const migration = await autoMigrateJsonToSqlite({
        configPath: options.migrateFromJson ?? settings.migrateFromJson,
        sqlitePath,
        sourceRequired: options.migrateFromJson != null || settings.migrateFromJsonRequired,
      });
      if (migration.status === 'migrated') {
        console.log(`已自动迁移旧 JSON 到 SQLite: ${migration.result.sqlitePath}`);
        log('info', '启动前自动迁移完成', {
          sqlitePath: migration.result.sqlitePath,
          revision: migration.result.revision,
          sourceFiles: migration.result.sourceFiles,
        });
      } else if (migration.status === 'skipped') {
        log('info', 'SQLite 已初始化，跳过 JSON 自动迁移', {
          sqlitePath: migration.sqlitePath,
          revision: migration.revision,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`自动迁移失败，服务未启动: ${message}`);
      log('error', '启动前自动迁移失败', { sqlitePath, error: message });
      process.exitCode = 1;
      return;
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
    } else if (options.cluster !== false) {
      // Cluster mode
      const workers = options.cluster === true ? 0 : Number(options.cluster);
      const { startCluster, resolveClusterWorkerCount } = await import('./cluster.js');
      const workerCount = resolveClusterWorkerCount(
        Number.isFinite(workers) && workers > 0 ? workers : settings.clusterWorkers
      );
      await writeProcessInfo({ pid: process.pid, port, host });
      process.on('exit', () => { void removeProcessInfo(); });

      await startCluster({
        workers: workerCount,
        startWorker: async () => {
          await startServer({
            host,
            port: Number.isFinite(port) ? port : settings.port,
            sqlitePath,
          });
        }
      });
    } else {
      await writeProcessInfo({ pid: process.pid, port, host });

      // cleanup on exit（SIGTERM/SIGINT 由 server.ts 统一处理，含 flushLogs）
      process.on('exit', () => { void removeProcessInfo(); });

      await startServer({
        host,
        port: Number.isFinite(port) ? port : settings.port,
        sqlitePath,
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

program
  .command('init-config')
  .description('在 SQLite 中初始化默认配置')
  .option('--sqlite-file <path>', 'SQLite 数据库路径', settings.sqliteFile)
  .action(async (options) => {
    const output = path.resolve(options.sqliteFile || settings.sqliteFile);
    let repository: SqliteConfigRepository | null = null;
    try {
      repository = new SqliteConfigRepository(output);
      const existingRevision = await repository.getConfigRevision();
      const config = await repository.ensureDefaultConfig(buildDefaultRuntimeConfig);
      const message = existingRevision == null ? 'SQLite 配置初始化完成' : 'SQLite 配置已存在，未做修改';
      console.log(`${message}: ${output} (revision=${config.revision ?? 1})`);
      log('info', message, { output, revision: config.revision ?? 1 });
    } catch (error) {
      log('error', '初始化 SQLite 配置失败', { output, error });
      process.exitCode = 1;
    } finally {
      repository?.close();
    }
  });

program
  .command('migrate')
  .description('将旧 JSON 配置和运行数据一次性迁移到 SQLite')
  .requiredOption('--config <path>', '旧 runtime_models.json 路径')
  .option('--sqlite-file <path>', 'SQLite 数据库路径', settings.sqliteFile)
  .option('--dry-run', '只校验并展示迁移摘要，不创建或修改数据库', false)
  .action(async (options) => {
    try {
      const result = await migrateJsonToSqlite({
        configPath: path.resolve(options.config),
        sqlitePath: path.resolve(options.sqliteFile || settings.sqliteFile),
        dryRun: options.dryRun === true,
      });
      const action = result.dryRun ? '迁移预检通过' : '迁移完成';
      console.log(
        `${action}: revision=${result.revision}, Provider=${result.providerCount}, `
        + `路由=${result.routeCount}, Key=${result.keyCount}, 状态=${result.stateCount}, `
        + `用量=${result.usageCount}, 历史=${result.historyCount}`,
      );
      console.log(`SQLite: ${result.sqlitePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`迁移失败: ${message}`);
      process.exitCode = 1;
    }
  });

void program.parseAsync(process.argv);
