#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { ProduceError, produce } from "./produce.mjs";

const USAGE =
  "usage: eve-appboundry build <app> --out <dir> --engine <@feltdb/feltkit>/appboundry/engine.wasm [--report <file>] [--json]";
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [command, app] = argv;
if (command !== "build" || !app || app.startsWith("--") || !flag("out")) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(64);
}
try {
  const result = await produce({
    appRoot: app,
    out: flag("out"),
    engine: flag("engine") ?? process.env.EVE_APPBOUNDRY_ENGINE,
  });
  const reportPath = flag("report") ?? `${result.path}.report.json`;
  writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  if (argv.includes("--json"))
    process.stdout.write(
      `${JSON.stringify({ path: result.path, report: reportPath, ...result.report }, null, 2)}\n`,
    );
  else {
    const { application, bytes, interfaces, keep, stubbed, agent } = result.report;
    process.stdout.write(
      [
        `ok  ${application.id}@${application.version} -> ${result.path}`,
        `    interfaces ${Object.entries(interfaces)
          .map(([n, v]) => `${n}@${v}`)
          .join(", ")}`,
        `    program ${bytes.program} bytes, module ${bytes.module} bytes`,
        `    tools ${agent.tools.map((t) => t.tool).join(", ") || "none"}; kept ${keep.length} on-demand modules, stubbed ${Object.keys(stubbed).length}`,
        `    report ${reportPath}`,
      ].join("\n") + "\n",
    );
  }
} catch (error) {
  if (!(error instanceof ProduceError)) throw error;
  process.stderr.write(`error ${error.code}: ${error.message}\n`);
  if (error.report) {
    const reportPath = flag("report") ?? `${flag("out").replace(/\/$/, "")}.report.json`;
    writeFileSync(
      reportPath,
      `${JSON.stringify({ refused: { code: error.code, message: error.message }, ...error.report }, null, 2)}\n`,
    );
    process.stderr.write(`      the keep and stub decisions are in ${reportPath}\n`);
  }
  process.exitCode = 1;
}
