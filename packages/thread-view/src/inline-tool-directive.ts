import type { TimelineToolWorkRow } from "@bb/server-contract";

export function getInlineToolDirectiveCandidate(
  row: Pick<TimelineToolWorkRow, "status" | "toolName" | "output">,
): { name: string; text: string } | null {
  if (row.status !== "completed" || !row.toolName.startsWith("bb:") || row.output.length > 2_064) return null;
  const text = row.output.trim();
  const name = /^::([a-z][a-z0-9-]*)\{[^\r\n]{1,2048}\}$/.exec(text)?.[1];
  return name === undefined ? null : { name, text };
}
