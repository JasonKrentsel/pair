import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface CommandProgress {
  reviewId: string; index: number; status: "Running" | "Completed" | "Failed";
  text: string; raw?: string; truncated: boolean;
}
/** Native shell updates are cumulative snapshots, not deltas. UI only. */
export function outputTail(value: string): { text: string; raw: string; truncated: boolean } {
  const clean = stripTerminalSequences(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const chars = clean.slice(-32768);
  const lines = chars.split("\n");
  return { text: lines.slice(-400).join("\n"), raw: value.slice(-65536), truncated: value.length > 65536 || clean.length > chars.length || lines.length > 400 };
}
