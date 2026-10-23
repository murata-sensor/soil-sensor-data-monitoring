export function toCsv<Row extends object>(rows: Row[]): string {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const cell = (value: unknown): string => {
    if (value === undefined || value === null) return "";
    let text = String(value);
    if (typeof value === "string" && /^\s*[=+@-]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(cell).join(","), ...rows.map((row) => headers
    .map((header) => cell(Object.prototype.hasOwnProperty.call(row, header)
      ? (row as Record<string, unknown>)[header] : undefined)).join(","))].join("\r\n");
}
