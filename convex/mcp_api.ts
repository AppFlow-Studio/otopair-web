/**
 * mcp_api.ts — Generic MCP database access layer (DROP-IN)
 *
 * Drop this file into ANY Convex project's convex/ folder.
 * It auto-discovers every table, field, and index from your schema.ts.
 * No hardcoded table names — works with any database schema.
 *
 * Pair with the MCP routes in http.ts for full remote access.
 *
 * SETUP: Just copy mcp_api.ts + the MCP section of http.ts into your project.
 */

import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import schema from "./schema";

// ---- Auto-discover schema at import time ----

function discoverSchema(): Record<string, { fields: string[]; indexes: string[] }> {
  const map: Record<string, { fields: string[]; indexes: string[] }> = {};

  for (const [tableName, tableDef] of Object.entries(schema.tables)) {
    // Get index names + their fields via the export() method
    let indexNames: string[] = [];
    try {
      const exported = (tableDef as any).export();
      if (exported.indexes) {
        indexNames = exported.indexes.map((idx: any) => idx.indexDescriptor);
      }
    } catch {
      // Fallback: try the " indexes"() method (note leading space)
      try {
        const idxFn = (tableDef as any)[" indexes"];
        if (typeof idxFn === "function") {
          indexNames = idxFn().map((idx: any) => idx.indexDescriptor);
        }
      } catch { /* no indexes discoverable */ }
    }

    // Get field names from the validator if possible
    let fields: string[] = [];
    try {
      const exported = (tableDef as any).export();
      const docType = exported.documentType;
      if (docType && docType.type === "object" && docType.value) {
        fields = Object.keys(docType.value);
      }
    } catch { /* fields will be discovered from sample docs at query time */ }

    map[tableName] = { fields, indexes: indexNames };
  }

  return map;
}

const SCHEMA_MAP = discoverSchema();

// ---- Get full schema ----

export const getSchema = internalQuery({
  args: {},
  handler: async () => {
    return {
      table_count: Object.keys(SCHEMA_MAP).length,
      tables: SCHEMA_MAP,
    };
  },
});

// ---- Read documents from any table (up to limit) ----

export const readTable = internalQuery({
  args: {
    table: v.string(),
    limit: v.optional(v.float64()),
  },
  handler: async (ctx, { table, limit }) => {
    if (!SCHEMA_MAP[table]) return { error: `Unknown table: ${table}` };
    const max = Math.min(limit || 50, 100);
    const docs = await (ctx.db.query(table as any) as any).take(max);

    // If schema didn't have field info, infer from first document
    if (SCHEMA_MAP[table].fields.length === 0 && docs.length > 0) {
      SCHEMA_MAP[table].fields = Object.keys(docs[0]).filter(
        (k) => k !== "_id" && k !== "_creationTime"
      );
    }

    return { table, count: docs.length, limit: max, documents: docs };
  },
});

// ---- Count documents in a table ----

export const countTable = internalQuery({
  args: {
    table: v.string(),
  },
  handler: async (ctx, { table }) => {
    if (!SCHEMA_MAP[table]) return { error: `Unknown table: ${table}` };
    const docs = await (ctx.db.query(table as any) as any).collect();
    return { table, count: docs.length };
  },
});

// ---- Get a single document by ID ----

export const getById = internalQuery({
  args: {
    id: v.string(),
  },
  handler: async (ctx, { id }) => {
    try {
      const doc = await ctx.db.get(id as any);
      return doc;
    } catch {
      return null;
    }
  },
});

// ---- Search table by index ----

export const queryByIndex = internalQuery({
  args: {
    table: v.string(),
    index: v.string(),
    value: v.any(),
    limit: v.optional(v.float64()),
  },
  handler: async (ctx, { table, index, value, limit }) => {
    if (!SCHEMA_MAP[table]) return { error: `Unknown table: ${table}` };
    const max = Math.min(limit || 50, 100);

    // Discover the first field of the index so we know what to .eq() on
    let indexField: string | null = null;
    try {
      const exported = (schema.tables as any)[table].export();
      const idx = exported.indexes?.find((i: any) => i.indexDescriptor === index);
      if (idx && idx.fields?.length > 0) {
        indexField = idx.fields[0];
      }
    } catch { /* fallback below */ }

    // Fallback: derive field name from index name (e.g. "by_make_id" → "make_id")
    if (!indexField) {
      indexField = index.replace(/^by_/, "");
    }

    const docs = await (ctx.db.query(table as any) as any)
      .withIndex(index, (q: any) => q.eq(indexField, value))
      .take(max);

    return { table, index, indexField, count: docs.length, documents: docs };
  },
});

// ---- Get table stats (counts for all or specified tables) ----

export const getTableStats = internalQuery({
  args: {
    tables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { tables }) => {
    const tableNames = tables || Object.keys(SCHEMA_MAP);
    const stats: Record<string, number> = {};

    for (const t of tableNames) {
      try {
        const docs = await (ctx.db.query(t as any) as any).collect();
        stats[t] = docs.length;
      } catch {
        stats[t] = -1;
      }
    }

    return stats;
  },
});

// ============================================================
// WRITE OPERATIONS
// ============================================================

// ---- Insert a document into any table ----

export const insertDoc = internalMutation({
  args: {
    table: v.string(),
    doc: v.any(),
  },
  handler: async (ctx, { table, doc }) => {
    if (!SCHEMA_MAP[table]) throw new Error(`Unknown table: ${table}`);
    const id = await (ctx.db as any).insert(table, doc);
    return { table, _id: id };
  },
});

// ---- Update (patch) a document by ID ----

export const updateDoc = internalMutation({
  args: {
    id: v.string(),
    fields: v.any(),
  },
  handler: async (ctx, { id, fields }) => {
    await (ctx.db as any).patch(id as any, fields);
    const updated = await ctx.db.get(id as any);
    return updated;
  },
});

// ---- Replace a document entirely (keeps same ID) ----

export const replaceDoc = internalMutation({
  args: {
    id: v.string(),
    doc: v.any(),
  },
  handler: async (ctx, { id, doc }) => {
    await (ctx.db as any).replace(id as any, doc);
    const replaced = await ctx.db.get(id as any);
    return replaced;
  },
});

// ---- Delete a document by ID ----

export const deleteDoc = internalMutation({
  args: {
    id: v.string(),
  },
  handler: async (ctx, { id }) => {
    await (ctx.db as any).delete(id as any);
    return { deleted: id };
  },
});

// ---- Bulk insert documents into a table ----

export const bulkInsert = internalMutation({
  args: {
    table: v.string(),
    docs: v.array(v.any()),
  },
  handler: async (ctx, { table, docs }) => {
    if (!SCHEMA_MAP[table]) throw new Error(`Unknown table: ${table}`);
    const ids: string[] = [];
    for (const doc of docs) {
      const id = await (ctx.db as any).insert(table, doc);
      ids.push(id);
    }
    return { table, inserted: ids.length, ids };
  },
});

// ---- Bulk delete documents by IDs ----

export const bulkDelete = internalMutation({
  args: {
    ids: v.array(v.string()),
  },
  handler: async (ctx, { ids }) => {
    let deleted = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await (ctx.db as any).delete(id as any);
        deleted++;
      } catch (e: any) {
        errors.push(`${id}: ${e.message}`);
      }
    }
    return { deleted, errors: errors.length > 0 ? errors : undefined };
  },
});
