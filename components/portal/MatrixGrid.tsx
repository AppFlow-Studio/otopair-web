"use client";

// Heat-cell matrix (Coverage page's make × year-band grid, Data spec §10.4).
// Generic: rows × columns of 0..1 cells shaded by value, with an optional
// per-cell secondary line (e.g. config count). Wide matrices scroll inside
// their own container.

export type MatrixCell = {
  /** 0..1 fill fraction driving the shade; null renders an empty cell. */
  value: number | null;
  /** Small second line inside the cell (e.g. "12 cfg"). */
  sub?: string;
  title?: string;
};

export type MatrixGridProps = {
  rowLabels: string[];
  colLabels: string[];
  /** cells[rowIdx][colIdx] */
  cells: MatrixCell[][];
};

function shade(v: number): string {
  // slate-50 → emerald scale; red-tinted at the very bottom so gaps pop.
  if (v >= 0.9) return "bg-emerald-500 text-white";
  if (v >= 0.75) return "bg-emerald-400 text-white";
  if (v >= 0.6) return "bg-emerald-300 text-emerald-950";
  if (v >= 0.45) return "bg-emerald-200 text-emerald-950";
  if (v >= 0.3) return "bg-amber-200 text-amber-950";
  if (v >= 0.15) return "bg-amber-100 text-amber-900";
  return "bg-red-100 text-red-900";
}

export function MatrixGrid({ rowLabels, colLabels, cells }: MatrixGridProps) {
  return (
    <div className="overflow-x-auto">
      <table className="border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th />
            {colLabels.map((c) => (
              <th key={c} className="px-1 pb-1 text-[11px] font-semibold text-slate-500">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowLabels.map((r, ri) => (
            <tr key={r}>
              <td className="pr-2 text-right text-[12px] font-medium text-slate-700">{r}</td>
              {colLabels.map((_, ci) => {
                const cell = cells[ri]?.[ci];
                if (!cell || cell.value == null) {
                  return (
                    <td key={ci}>
                      <div className="h-11 w-16 rounded-md border border-dashed border-slate-200" />
                    </td>
                  );
                }
                return (
                  <td key={ci}>
                    <div
                      title={cell.title}
                      className={`flex h-11 w-16 flex-col items-center justify-center rounded-md ${shade(cell.value)}`}
                    >
                      <span className="text-[12px] font-bold leading-none">
                        {Math.round(cell.value * 100)}%
                      </span>
                      {cell.sub && (
                        <span className="mt-0.5 text-[10px] leading-none opacity-80">{cell.sub}</span>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
