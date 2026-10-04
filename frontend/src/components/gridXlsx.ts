/**
 * XLSX export for <DataGrid onExportXlsx>: sends the visible columns and the
 * filtered, sorted rows to POST /exports/xlsx and downloads the workbook.
 * Numbers and booleans stay typed; everything else goes as the cell's display text.
 */
import { cellText, cellValue, type DataGridColumn } from "./datagrid";

// Same base as api.ts (kept in step with it).
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? "/api" : "http://localhost:8000");

type ExportCell = string | number | boolean | null;

export function gridExportRows<T>(rows: ReadonlyArray<T>, columns: ReadonlyArray<DataGridColumn<T>>): Array<Record<string, ExportCell>> {
  return rows.map((row) => {
    const record: Record<string, ExportCell> = {};
    for (const column of columns) {
      const value = cellValue(column, row);
      if (!column.format && typeof value === "number") record[column.key] = Number.isFinite(value) ? value : null;
      else if (!column.format && typeof value === "boolean") record[column.key] = value;
      else {
        const text = cellText(column, row, value);
        record[column.key] = text === "" ? null : text;
      }
    }
    return record;
  });
}

/** Save a blob (an export, an import template) under a file name. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Export what the grid shows as `<fileName>.xlsx`. Rejects with the server's message on failure. */
export async function exportGridXlsx<T>(options: {
  title: string;
  fileName: string;
  rows: ReadonlyArray<T>;
  columns: ReadonlyArray<DataGridColumn<T>>;
}): Promise<void> {
  const { title, fileName, rows, columns } = options;
  const response = await fetch(`${API_BASE_URL}/exports/xlsx`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      file_name: fileName,
      columns: columns.map((column) => ({ key: column.key, header: column.header })),
      rows: gridExportRows(rows, columns)
    })
  });
  if (!response.ok) {
    let message = `XLSX export failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  downloadBlob(await response.blob(), match?.[1] ?? `${fileName}.xlsx`);
}
