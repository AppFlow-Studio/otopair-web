type Row = Record<string, any>;

/** Minimal in-memory Convex db fake — same shape as the inline copy in
 *  tests/quoteEngineLabor.test.ts, extracted so labor unit tests share it. */
export function fakeDb(tables: Record<string, Row[]>) {
  const matches = (row: Row, eqs: [string, any][]) =>
    eqs.every(([f, v]) => row[f] === v);
  const db = {
    patches: [] as { id: any; patch: Row }[],
    inserts: [] as { table: string; doc: Row }[],
    query(table: string) {
      const builder = (eqs: [string, any][]) => ({
        collect: async () => (tables[table] ?? []).filter((r) => matches(r, eqs)),
        first: async () =>
          (tables[table] ?? []).filter((r) => matches(r, eqs))[0] ?? null,
        unique: async () =>
          (tables[table] ?? []).filter((r) => matches(r, eqs))[0] ?? null,
      });
      return {
        withIndex(_name: string, fn?: (q: any) => any) {
          const eqs: [string, any][] = [];
          if (fn) {
            const q = { eq(field: string, value: any) { eqs.push([field, value]); return q; } };
            fn(q);
          }
          return builder(eqs);
        },
        ...builder([]),
      };
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) {
        const hit = rows.find((r) => r._id === id);
        if (hit) return hit;
      }
      return null;
    },
    async patch(id: any, patch: Row) { db.patches.push({ id, patch }); },
    async insert(table: string, doc: Row) { db.inserts.push({ table, doc }); },
  };
  return db;
}
