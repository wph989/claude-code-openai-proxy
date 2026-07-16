import cluster from 'node:cluster';
import { log } from './utils/logger.js';

export interface ClusterOptions {
  workers: number;
  startWorker: () => Promise<void>;
}

export function resolveClusterWorkerCount(workers: number): number {
  return workers > 0 ? workers : 1;
}

export function assertClusterWorkerCount(workers: number): void {
  if (workers <= 1) return;
  // Rotator、错误计数和本地配额当前都保存在进程内，多 Worker 会突破全局并发限制并互相覆盖 JSON 状态。
  throw new Error('当前本地状态存储不支持多 Worker 集群；请使用 --cluster 1，或等待接入集中式状态存储。');
}

export async function startCluster(options: ClusterOptions): Promise<void> {
  const numWorkers = resolveClusterWorkerCount(options.workers);
  assertClusterWorkerCount(numWorkers);

  if (cluster.isPrimary) {
    log('info', '集群主进程启动', {
      pid: process.pid,
      workers: numWorkers
    });

    // Fork workers
    for (let i = 0; i < numWorkers; i++) {
      cluster.fork();
    }

    let shuttingDown = false;
    let forceShutdownTimer: ReturnType<typeof setTimeout> | null = null;

    // Handle worker events
    cluster.on('exit', (worker, code, signal) => {
      log('warn', '工作进程退出', {
        worker_pid: worker.process.pid,
        code,
        signal
      });
      if (shuttingDown) {
        const hasLiveWorkers = Object.values(cluster.workers ?? {}).some(Boolean);
        if (!hasLiveWorkers) {
          if (forceShutdownTimer) clearTimeout(forceShutdownTimer);
          process.exit(0);
        }
        return;
      }
      // 只在正常运行期间补充异常退出的 Worker，关闭期间重新 fork 会让服务无法优雅停止。
      cluster.fork();
    });

    cluster.on('online', (worker) => {
      log('info', '工作进程就绪', {
        worker_pid: worker.process.pid
      });
    });

    // Handle graceful shutdown
    const handleShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('info', '收到退出信号，准备关闭集群', { signal });

      // Disconnect all workers
      for (const id in cluster.workers) {
        cluster.workers[id]?.disconnect();
      }

      // Wait for workers to exit
      forceShutdownTimer = setTimeout(() => {
        log('warn', '强制关闭未退出的工作进程');
        for (const id in cluster.workers) {
          cluster.workers[id]?.kill();
        }
        process.exit(0);
      }, 10000);
    };

    process.once('SIGINT', () => void handleShutdown('SIGINT'));
    process.once('SIGTERM', () => void handleShutdown('SIGTERM'));
  } else {
    // Worker process
    await options.startWorker();
  }
}
