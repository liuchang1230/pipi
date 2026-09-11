/**
 * transcript-from-file.ts — a session file's content → the messages pi's
 * `get_messages` would return for it.
 *
 * The IPC handler (`session:transcript-from-file`) is a thin shell around this
 * so the safety-critical contract stays unit-testable: **an unusable file
 * returns `null`, never an empty or partial transcript.** The caller falls back
 * to the RPC path on `null`, which is what makes a pi format change degrade to
 * "slow but correct" instead of "blank chat".
 *
 * Parsing is COOPERATIVE (`parseTreeFileAsync`): a multi-MB session file is
 * thousands of `JSON.parse` calls, and doing that synchronously on the main
 * process would stall every IPC and the terminal stream — the very
 * "未响应" this feature exists to remove.
 *
 * Resolution itself lives in `shared/transcript.ts` (mirrors pi's compaction
 * semantics; pinned by a differential test against pi).
 */
import { parseTreeFileAsync } from "./tree-from-file";
import { sessionContextMessages, type TranscriptEntry } from "../shared/transcript";

/**
 * The messages for a session file's content, or `null` when there is nothing
 * usable to show (empty file, unparsable, no messages on the branch).
 */
export async function transcriptFromContent(content: string): Promise<unknown[] | null> {
  const { entries, leafId } = await parseTreeFileAsync(content);
  const messages = sessionContextMessages(entries as TranscriptEntry[], leafId);
  return messages.length > 0 ? messages : null;
}
