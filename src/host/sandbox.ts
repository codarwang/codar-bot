/**
 * sandbox — the §3.4 docker runner argv builder.
 *
 * docker run -i --rm
 *   -v <workDir>:/home/bot/work            (bot-private, rw)
 *   -v <piConfDir>:/state/pi-conf          (agent dir: models.json + sessions carrier, rw)
 *   -v <extensionsDir>:/opt/codar-ext:ro   (codar-gate, read-only)
 *   -e KEY=VALUE …                          (provider chain env — docker does
 *                                            NOT inherit spawn env, every
 *                                            key rides an explicit -e)
 *   -e PI_CODING_AGENT_DIR=/state/pi-conf
 *   <image>
 * The image entrypoint IS pi (tini PID-1), so rpc flags follow the image.
 */
export const DEFAULT_SANDBOX_IMAGE = "codar-bot-sandbox:0.1";

export interface SandboxArgs {
  image: string;
  workDir: string;
  piConfDir: string;
  /** Host path of the extensions dir (contains codar-gate/). */
  extensionsDir: string;
  /** Container path of the extension entry (relative to the mount).
   *  Defaults to GATE_EXTENSION_ENTRY; callers may omit it. */
  extensionEntry?: string;
  env: Record<string, string>;
}

/** Single source for the in-container gate entry (drift hazard otherwise). */
export const GATE_EXTENSION_ENTRY = "codar-gate/codar-gate.ts";

export function buildDockerArgv(args: SandboxArgs): string[] {
  const argv = [
    "run", "-i", "--rm",
    // -w pins the cwd to the work mount (the image WORKDIR happens to match;
    // this removes the coincidence coupling).
    "-w", "/home/bot/work",
    "-v", `${args.workDir}:/home/bot/work`,
    "-v", `${args.piConfDir}:/state/pi-conf`,
    "-v", `${args.extensionsDir}:/opt/codar-ext:ro`,
  ];
  // NOTE (M2): the Room sharedDir mount joins here once rooms have an
  // engine (bot↔room is N:M — it cannot be derived from the bot record).
  for (const [key, value] of Object.entries(args.env)) {
    argv.push("-e", `${key}=${value}`);
  }
  argv.push(args.image);
  return argv;
}
