import {
  inspectRuntimeState,
  installNativeMessagingManifest,
  type BrowserName,
} from "./install.ts";
import { runNativeHost } from "./native-host.ts";

const HELP = `Browser Profile Title Native Messaging Host

Usage:
  browser-profile-title-host doctor [--channel <name>] [--state-base <directory>]
  browser-profile-title-host install --dry-run [--binary <standalone>] [--browser chrome|chromium|edge]
      [--state-dir <browser-user-data-root>] [--replace]
  browser-profile-title-host install [the same options]   Write the user-level Native Messaging manifest
  browser-profile-title-host run <chrome-extension-origin>  Run the stdio host for a local fixture

The browser's Native Messaging launch passes its origin directly to the executable.
--state-dir selects the browser user-data root for the manifest location. It does not
change the runtime pairing-state directory. Browser data stays outside the Obsidian vault.
`;

type ParsedOptions = {
  dryRun: boolean;
  replace: boolean;
  browser?: BrowserName;
  binaryPath?: string;
  stateDir?: string;
  stateBase?: string;
  channel?: string;
  remaining: string[];
};

function parseOptions(args: string[]): ParsedOptions {
  const options: ParsedOptions = {
    dryRun: false,
    replace: false,
    remaining: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--replace") options.replace = true;
    else if (
      argument === "--binary" ||
      argument === "--state-dir" ||
      argument === "--state-base" ||
      argument === "--browser" ||
      argument === "--channel"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${argument}`);
      index += 1;
      if (argument === "--binary") options.binaryPath = value;
      else if (argument === "--state-dir") options.stateDir = value;
      else if (argument === "--state-base") options.stateBase = value;
      else if (argument === "--browser") {
        if (value !== "chrome" && value !== "chromium" && value !== "edge") {
          throw new Error("Choose Chrome, Chromium, or Edge");
        }
        options.browser = value;
      } else options.channel = value;
    } else if (argument === "--help" || argument === "-h") {
      options.remaining.push("help");
    } else if (argument.startsWith("--")) {
      throw new Error("An unsupported command option was provided");
    } else options.remaining.push(argument);
  }
  return options;
}

function fixedFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message && !("code" in error))
    return error.message;
  return "The command could not be completed. Check local permissions and the selected paths.";
}

export async function runCli(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (args[0] === "doctor") {
    const parsed = parseOptions(args.slice(1));
    if (parsed.remaining.length > 0)
      throw new Error("Doctor does not accept positional arguments");
    const report = await inspectRuntimeState({
      channel: parsed.channel,
      stateBase: parsed.stateBase,
    });
    process.stdout.write(
      `Runtime state: ${report.state} (channel: ${report.channel})\n`,
    );
    return report.state === "unsafe-state" ? 1 : 0;
  }

  if (args[0] === "install") {
    const parsed = parseOptions(args.slice(1));
    if (parsed.remaining.length > 0)
      throw new Error("Install does not accept positional arguments");
    const result = await installNativeMessagingManifest({
      browser: parsed.browser,
      binaryPath: parsed.binaryPath,
      stateDir: parsed.stateDir,
      replace: parsed.replace,
      dryRun: parsed.dryRun,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (args[0] === "run") {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await runNativeHost({
        argv: args.slice(1),
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await runNativeHost({ argv: args, signal: controller.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${fixedFailureMessage(error)}\n`);
    process.exitCode = 1;
  }
}
