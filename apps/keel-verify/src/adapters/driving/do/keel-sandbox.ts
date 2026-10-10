import { CiSandbox } from "./ci-sandbox.js";

type BackupOptions = Parameters<CiSandbox["createBackup"]>[0];
type BackupHandle = Parameters<CiSandbox["restoreBackup"]>[0];

/**
 * KeelSandbox (ExecBox): the Tier 2 runner KeelVerify's `ci.runner` steps run
 * in. Backups and restores go through the BACKUP_BUCKET binding
 * (`localBucket`), so no R2 S3 keys reach the container. Never put a credential
 * in a container's start environment: it lands on disk and in /proc.
 */
export class KeelSandbox extends CiSandbox {
  override async createBackup(options: BackupOptions) {
    return super.createBackup({ ...options, localBucket: true });
  }

  override async restoreBackup(backup: BackupHandle) {
    return super.restoreBackup({ ...backup, localBucket: true });
  }
}
