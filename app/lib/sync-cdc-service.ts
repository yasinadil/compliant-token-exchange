// app/lib/sync-cdc-service.ts
// Change-data-capture scanner. For each registered entity it selects rows
// changed since the last watermark and enqueues an outbox job for each, then
// advances the watermark — atomically per batch. This mirrors ALL business
// tables completely (good for compliance) without instrumenting every write
// site. The outbox worker then delivers the enqueued jobs downstream.

import "server-only";
import type { RowDataPacket } from "mysql2/promise";
import { db, withMysqlRetry } from "./db";
import { enqueueSyncJob, isSyncOutboxEnabled } from "./sync-outbox-service";
import { SYNC_ENTITIES, type SyncEntityDescriptor } from "./sync-entities";

const CDC_BATCH_SIZE = Number(process.env.OUTBOX_CDC_BATCH_SIZE) || 200;
const CDC_MAX_BATCHES_PER_SWEEP =
  Number(process.env.OUTBOX_CDC_MAX_BATCHES) || 25;

const EPOCH = "1970-01-01 00:00:00.000";

export interface CdcEntityResult {
  entity: string;
  enqueued: number;
  batches: number;
  error?: string;
}

export interface CdcScanResult {
  entities: CdcEntityResult[];
  totalEnqueued: number;
}

/** Whether CDC scanning is on. Defaults to following the outbox master switch. */
export function isCdcEnabled(): boolean {
  const flag = (process.env.SYNC_CDC_ENABLED || "").toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return isSyncOutboxEnabled(); // default: on when the outbox is on
}

interface Watermark {
  wm: string | Date;
  id: number;
}

async function readWatermark(entity: string): Promise<Watermark> {
  const [rows] = await withMysqlRetry(() =>
    db.query<RowDataPacket[]>(
      `SELECT last_watermark, last_id FROM sync_cdc_state WHERE entity = ?`,
      [entity]
    )
  );
  if (rows.length === 0) return { wm: EPOCH, id: 0 };
  return { wm: rows[0].last_watermark as Date, id: Number(rows[0].last_id) };
}

function buildSelect(desc: SyncEntityDescriptor): string {
  const fieldSelects = Object.entries(desc.fields)
    .map(([key, expr]) => `${expr} AS \`${key}\``)
    .join(", ");
  return `
    SELECT ${desc.idExpr} AS __id,
           ${desc.watermarkExpr} AS __wm,
           ${desc.naturalKeyExpr} AS __key,
           ${fieldSelects}
      FROM ${desc.from}
     WHERE (${desc.watermarkExpr} > ?)
        OR (${desc.watermarkExpr} = ? AND ${desc.idExpr} > ?)
     ORDER BY ${desc.watermarkExpr} ASC, ${desc.idExpr} ASC
     LIMIT ?`;
}

/** Scan one entity, enqueuing changed rows and advancing its watermark. */
async function scanEntity(desc: SyncEntityDescriptor): Promise<CdcEntityResult> {
  const sql = buildSelect(desc);
  let enqueued = 0;
  let batches = 0;
  let { wm, id } = await readWatermark(desc.entity);

  for (let i = 0; i < CDC_MAX_BATCHES_PER_SWEEP; i++) {
    const [rows] = await withMysqlRetry(() =>
      db.query<RowDataPacket[]>(sql, [wm, wm, id, CDC_BATCH_SIZE])
    );
    if (rows.length === 0) break;

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      for (const row of rows) {
        const data: Record<string, unknown> = {};
        for (const key of Object.keys(desc.fields)) {
          data[key] = normalize(row[key]);
        }
        await enqueueSyncJob(connection, {
          aggregateType: desc.entity,
          aggregateId: String(row.__key),
          operation: "UPDATE", // downstream upserts; creates the row if missing
          data,
        });
        enqueued += 1;
      }

      const last = rows[rows.length - 1];
      wm = last.__wm as Date;
      id = Number(last.__id);

      // Advance the watermark inside the same tx as the enqueues.
      await connection.execute(
        `INSERT INTO sync_cdc_state (entity, last_watermark, last_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_watermark = VALUES(last_watermark), last_id = VALUES(last_id)`,
        [desc.entity, wm, id]
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    batches += 1;
    if (rows.length < CDC_BATCH_SIZE) break; // drained
  }

  return { entity: desc.entity, enqueued, batches };
}

/**
 * Run one CDC pass across all registered entities. Per-entity failures are
 * isolated (recorded, not fatal) so one bad table doesn't stall the rest.
 */
export async function runCdcScan(): Promise<CdcScanResult> {
  const results: CdcEntityResult[] = [];

  for (const desc of SYNC_ENTITIES) {
    try {
      results.push(await scanEntity(desc));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SyncCDC] entity ${desc.entity} scan failed: ${msg}`);
      results.push({ entity: desc.entity, enqueued: 0, batches: 0, error: msg });
    }
  }

  const totalEnqueued = results.reduce((n, r) => n + r.enqueued, 0);
  return { entities: results, totalEnqueued };
}

/** Convert DB values to JSON-stable forms (Date -> ISO). */
function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}
