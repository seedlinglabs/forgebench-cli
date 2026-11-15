import { execFile } from "node:child_process"
import { basename } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { repositoryIdentity, safeName } from "../core/redact.js"

export { repositoryIdentity, safeName } from "../core/redact.js"

/** `git remote get-url origin` only (never a forgebench binary); bounded and non-interactive. */
function originRemote(directory: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], {
      cwd: directory, timeout: 1000, maxBuffer: 4096,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => resolve(error ? undefined : String(stdout)))
  })
}

/** Names and repository identity only. No absolute path, auth URL or free text. */
export async function executionContext(ctx: Pick<Plugin.Context, "location" | "vcs">) {
  const repo = safeName(basename(ctx.location.directory))
  const vcs = await ctx.vcs.get().catch(() => undefined)
  const branch = safeName(vcs?.data.branch.current)
  const repository = repositoryIdentity(await originRemote(ctx.location.directory))
  return { ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...(repository ? { repository } : {}) }
}
