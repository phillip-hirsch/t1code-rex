// @effect-diagnostics globalFetch:off -- tr3x runs on Bun outside the Effect runtime.
import { type EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface EnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverVersion: string;
  readonly orchestrationProtocolVersion: number | null;
}

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

/** Reads the server's public descriptor. It needs no credential, so it doubles as the health check. */
export async function fetchEnvironmentSummary(
  httpBaseUrl: string,
  timeoutMs = 2_000,
): Promise<EnvironmentSummary> {
  const response = await fetch(new URL("/.well-known/t3/environment", httpBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Server descriptor request failed (${response.status}).`);
  }
  const descriptor = decodeDescriptor(await response.json());
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    serverVersion: descriptor.serverVersion,
    orchestrationProtocolVersion: descriptor.orchestrationProtocolVersion ?? null,
  };
}

export function describeServer(environment: EnvironmentSummary, httpBaseUrl: string): string {
  const protocol = environment.orchestrationProtocolVersion ?? "unknown";
  return `T3 server ${environment.serverVersion} (orchestration protocol ${protocol}) at ${httpBaseUrl}`;
}

/** Signal 0 only probes. EPERM still means the process exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
