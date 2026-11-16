import {
  createConnection,
  ensurePersonalProject,
  initializeLocalTurnRequestIndex,
  migrate,
  threadConversationOutlines,
} from "@bb/db";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import {
  exportLegacyAutomationsForPluginImport,
  hasLegacyAutomationsToExport,
} from "./legacy-automations-export.js";

type InitDbLogger = MigrationWarningLogger &
  SlowDbQueryLogger &
  Pick<Logger, "error" | "info" | "warn">;

interface InitDbOptions {
  dataDir?: string;
  slowQueryThresholdMs?: number | (() => number);
  slowQueryDiagnosticsEnabled?: () => boolean;
  logger?: InitDbLogger;
}

export function initDb(
  databasePath: string,
  options: InitDbOptions = {},
): DbConnection {
  const db = createConnection(databasePath, {
    slowQueryLogger: options.logger,
    slowQueryThresholdMs: options.slowQueryThresholdMs,
    slowQueryDiagnosticsEnabled: options.slowQueryDiagnosticsEnabled,
  });
  try {
    if (options.dataDir !== undefined && options.logger !== undefined) {
      exportLegacyAutomationsForPluginImport({
        dataDir: options.dataDir,
        db,
        logger: options.logger,
      });
    } else if (hasLegacyAutomationsToExport(db)) {
      throw new Error(
        "Cannot migrate legacy automations without dataDir and logger; refusing to drop kernel automation rows before exporting them for the automations plugin",
      );
    }
    migrate(db, { logger: options.logger });
    db.delete(threadConversationOutlines).run();
    ensurePersonalProject(db);
    initializeLocalTurnRequestIndex(db, options.logger);
  } catch (error) {
    db.$client.close();
    throw error;
  }
  return db;
}
