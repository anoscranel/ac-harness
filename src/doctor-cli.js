// src/doctor-cli.js — v0.8.0 S4: "is this install usable?" Six checks max,
// each ok/warn/fail + a remediation line; exit non-zero ONLY on fail
// (warn is usable). The node-version check goes through an INJECTABLE env
// seam (AC_FAKE_NODE_VERSION) so a test can fake a low version without
// touching the real runtime (the card's own DC5 requirement).

import { spawnSync } from "node:child_process";
import { access, constants, readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

/**
 * One check. status ∈ ok|warn|fail. remediation is ALWAYS printed —
 * a check nobody can act on is removed instead (card self-pushback 2).
 * @typedef {{name:string, status:"ok"|"warn"|"fail", detail:string, remediation:string}} Check
 */

async function checkNodeVersion() {
  // env seam: tests fake a version here; the real runtime is never modified
  const raw = process.env.AC_FAKE_NODE_VERSION ?? process.version;
  const m = /^v(\d+)\./.exec(raw);
  const major = m ? Number(m[1]) : 0;
  if (major >= 24) {
    return { name: "node", status: "ok", detail: `${raw}`, remediation: "" };
  }
  return {
    name: "node",
    status: "fail",
    detail: `${raw} (needs >= 24)`,
    remediation: "install Node >= 24 (the harness uses globals and node:* APIs from that line)",
  };
}

async function checkRg() {
  const r = spawnSync("rg", ["--version"], { encoding: "utf8" });
  if (!r.error && r.status === 0) {
    return { name: "rg", status: "ok", detail: (r.stdout.split("\n")[0] ?? "").trim(), remediation: "" };
  }
  return {
    name: "rg",
    status: "warn",
    detail: "not found",
    remediation: "the grep tool degrades with a clear message without rg; install ripgrep for grep to run",
  };
}

async function checkLogDir() {
  const dir = resolve("logs");
  try {
    await access(dir, constants.W_OK);
    return { name: "log dir", status: "ok", detail: `${dir} writable`, remediation: "" };
  } catch {
    return {
      name: "log dir",
      status: "fail",
      detail: `${dir} not writable`,
      remediation: `create it or fix permissions: mkdir -p ${dir} && chmod u+w ${dir}`,
    };
  }
}

async function checkProvider() {
  const { listEnvProviders, loadProfiles } = await import("./providers/registry.js");
  const envRows = listEnvProviders(process.env);
  let fileRows = [];
  try {
    fileRows = await loadProfiles("providers.config.json");
  } catch {
    fileRows = [];
  }
  const total = envRows.length + fileRows.length;
  if (total > 0) {
    return {
      name: "provider",
      status: "ok",
      detail: `${total} configured (${envRows.length} env · ${fileRows.length} file)`,
      remediation: "",
    };
  }
  return {
    name: "provider",
    status: "ok", // explicit offline state, not a failure
    detail: "none configured — using echo (offline)",
    remediation: "optional: add one via HARNESS_PROVIDER_<ID>_BASE_URL env vars or the TUI ? panel",
  };
}

async function checkPlugins() {
  const dir = resolve("plugins");
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return {
      name: "plugins",
      status: "warn",
      detail: "no plugins dir",
      remediation: "optional: create plugins/ with one manifest.json per plugin",
    };
  }
  const manifests = entries.filter((e) => !e.startsWith("."));
  if (manifests.length === 0) {
    return {
      name: "plugins",
      status: "ok",
      detail: "none (bare install)",
      remediation: "",
    };
  }
  let bad = 0;
  for (const m of manifests) {
    try {
      JSON.parse(await readFile(join(dir, m, "manifest.json"), "utf8"));
    } catch {
      bad += 1;
    }
  }
  if (bad === 0) {
    return { name: "plugins", status: "ok", detail: `${manifests.length} manifest(s) parse`, remediation: "" };
  }
  return {
    name: "plugins",
    status: "warn",
    detail: `${bad}/${manifests.length} manifest(s) unparseable`,
    remediation: "a rejected plugin is skipped at startup (plugin.rejected is logged); fix or remove its manifest.json",
  };
}

async function checkGit() {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (!r.error && r.status === 0) {
    return { name: "git", status: "ok", detail: (r.stdout.split("\n")[0] ?? "").trim(), remediation: "" };
  }
  return {
    name: "git",
    status: "warn",
    detail: "not found",
    remediation: "nothing in the core needs git; install it only for your own workflow",
  };
}

/**
 * @returns {Promise<{lines:string[], exitCode:number}>}
 */
export async function doctorCommand({ stdout = process.stdout } = {}) {
  const lines = [];
  const out = (s) => {
    lines.push(s);
    if (stdout) stdout.write(s + "\n");
  };
  const checks = [
    await checkNodeVersion(),
    await checkRg(),
    await checkLogDir(),
    await checkProvider(),
    await checkPlugins(),
    await checkGit(),
  ];
  let failed = 0;
  for (const c of checks) {
    const tag = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    out(`${tag}  ${c.name}: ${c.detail}`);
    if (c.remediation) out(`      remediation: ${c.remediation}`);
    if (c.status === "fail") failed += 1;
  }
  out(failed === 0 ? "doctor: usable" : `doctor: ${failed} check(s) failed`);
  return { lines, exitCode: failed === 0 ? 0 : 1 };
}

export default doctorCommand;
