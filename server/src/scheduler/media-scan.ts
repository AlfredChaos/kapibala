// 媒体扫描的调度器注册行（T-P8-01；DES/05 §7 双职责：下载 + 每日清理）。
// 本文件只做接线：扫描体归 modules/messages/media.ts；
// 注册名恒为 MEDIA_*_SCAN_NAME——重名即接线错误，registry.register 启动即拒。
// 节拍：media-download 随 1s tick 每轮扫（吞吐型，谓词驱动）；media-cleanup 内部 24h
// 节流（契约「每日」粒度——registry 节拍不变，节流只省空转）。
import type { Pool } from 'pg';
import type { ScanRegistry } from './registry.js';
import {
  createMediaCleanupScan,
  createMediaDownloadScan,
  MEDIA_CLEANUP_SCAN_NAME,
  MEDIA_DOWNLOAD_SCAN_NAME,
  type MediaGateway,
  type MediaLogger,
} from '../modules/messages/media.js';

export interface MediaScanDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  readonly gateway: MediaGateway;
  readonly logger: MediaLogger;
  /** MEDIA_RETENTION_DAYS（config.mediaRetentionDays，默认 30，QR §1） */
  readonly retentionDays?: number;
}

/** boot 接线（index.ts 步骤 4）：下载随 tick、清理 24h 节流 */
export function registerMediaScans(deps: MediaScanDeps): void {
  deps.registry.register(
    MEDIA_DOWNLOAD_SCAN_NAME,
    createMediaDownloadScan({
      pool: deps.pool,
      gateway: deps.gateway,
      logger: deps.logger,
    }),
  );
  deps.registry.register(
    MEDIA_CLEANUP_SCAN_NAME,
    createMediaCleanupScan({
      pool: deps.pool,
      logger: deps.logger,
      retentionDays: deps.retentionDays,
    }),
  );
}
