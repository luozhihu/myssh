import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function relayTransferTool(
  svc: Service,
  args: {
    src_sid: string;
    src_path: string;
    dst_sids: string[];
    dst_path: string;
    timeout_ms?: number;
  },
) {
  try {
    const outcome = await svc.manager.relayTransfer(
      args.src_sid,
      args.src_path,
      args.dst_sids,
      args.dst_path,
      args.timeout_ms ?? 0,
    );
    const destinations = outcome.destinations.map((destination) => {
      const entry: Record<string, unknown> = {
        dst_sid: destination.dstSid,
        dst_server: destination.dstServer,
        ok: destination.ok,
        bytes: destination.bytes,
        timed_out: destination.timedOut,
      };
      if (destination.error) entry.error = destination.error;
      return entry;
    });
    const body: Record<string, unknown> = {
      ok: outcome.ok,
      downloaded_bytes: outcome.downloadedBytes,
      timed_out: outcome.timedOut,
      src_server: outcome.srcServer,
      destinations,
    };
    if (outcome.error) body.error = outcome.error;
    return textResult(body);
  } catch (err) {
    return errorResult(message(err));
  }
}
