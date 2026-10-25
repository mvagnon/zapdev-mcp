import { runSystemdService } from "./service-managers/systemd.js";

/** One named service configured in its repository or group directory. */
export type Service = { name: string; path: string; startCommand: string; stopCommand?: string };
/** Supported service lifecycle and diagnostic operations. */
export type ServiceAction = "start" | "stop" | "logs";
/** Observed service state, shutdown policy, and optional bounded diagnostics. */
export type ServiceResult = {
  name: string; path: string; id: string; state?: string; subState?: string;
  result?: string; exitCode?: number; exists?: boolean; logs?: string; truncated?: boolean; error?: string;
  mainPid?: number; controlPid?: number; tasks?: number; controlGroup?: string; maxRuntimeSeconds?: number;
};

/** Delegate service supervision to the supported platform backend. */
export async function runService(service: Service, action: ServiceAction, lines = 100): Promise<ServiceResult> {
  return runSystemdService(service, action, lines);
}
