import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Registry, AgentDef } from './registry/registry'
import { BRAND } from '../shared/brand'
import { hasMemory, type Memory } from '../shared/memory'

const BASE = `You are ${BRAND.title}, an interactive AI agent running on the user's Mac. You help with analysis, data, research and software tasks.

# How to work
- Use tools to act; don't just describe what you would do. To run code: write it with write_file, then run it with shell (e.g. \`python3 script.py\`).
- Before acting on a task that a listed skill covers, call the skill tool to load its full instructions, then follow them.
- For complex, separable work, delegate to sub-agents with the task tool. Emit multiple task calls in ONE response to run them in parallel. Use mode "background" for long work you can check later with read_agent.
- Make independent tool calls in parallel (several calls in one response).
- Give every shell call a short "description" (e.g. "Install dependencies"); the user sees it instead of the raw command.
- Use shell mode "async" for servers, watchers and long jobs, then read_shell / write_shell / stop_shell.
- Use web_fetch to read web pages. For multi-step work, track a plan in the sql tool's todos table.
- Before a batch of tool calls, write one short sentence saying what you're about to do and why.
- Never print secret values. Be concise in final answers.`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function environment(cwd: string): string {
  return `# Environment\n- Working folder: ${cwd}\n- OS: macOS ${os.release()}\n- Date: ${new Date().toISOString()}`
}

function skillsSection(reg: Registry): string {
  if (!reg.skills.length) return ''
  return `# Available skills (load with the skill tool)\n` + reg.skills.map((s) => `- ${s.name}: ${clip(s.description, 250)}`).join('\n')
}

function agentsSection(reg: Registry): string {
  if (!reg.agents.length) return ''
  return `# Available agents (pass as "agent" to the task tool)\n` + reg.agents.map((a) => `- ${a.name}: ${clip(a.description, 200)}`).join('\n')
}

const MEMORY_CAP = 60_000


function memoryBody(m: Partial<Memory>): string {
  const parts: string[] = []
  if (m.notes?.trim()) parts.push(`<notes>\n${clip(m.notes.trim(), MEMORY_CAP)}\n</notes>`)
  for (const p of m.files ?? []) {
    let body: string
    try { body = clip(fs.readFileSync(p, 'utf8'), MEMORY_CAP) } catch (e: any) { body = `(could not read: ${e.message})` }
    parts.push(`<memory file="${path.basename(p)}" path="${p}">\n${body}\n</memory>`)
  }
  return parts.join('\n\n')
}

/** Folder memory (shared by every chat in the working folder), then this chat's own memory. */
export function memorySection(session?: Partial<Memory> | null, folder?: Partial<Memory> | null): string {
  const out: string[] = []
  if (hasMemory(folder)) out.push(`# Folder memory\nThe user keeps these notes and files for every ${BRAND.title} chat in this working folder: standing facts, preferences and decisions for the project. Follow them unless the user says otherwise in this chat. Files are usually exports of earlier chats; build on their findings and say so when you rely on them.\n\n${memoryBody(folder!)}`)
  if (hasMemory(session)) out.push(`# Session memory\nThe user attached these notes and files to this chat as background context (files are usually exports of earlier ${BRAND.title} chats). Treat them as things already discussed: build on their findings and decisions, and say so when you rely on them. Where they conflict with folder memory, session memory wins.\n\n${memoryBody(session!)}`)
  return out.join('\n\n')
}

export function buildMainSystem(reg: Registry, cwd: string, memory?: Partial<Memory> | null, folderMemory?: Partial<Memory> | null): string {
  return [BASE, environment(cwd), reg.instructions && `# User and project instructions\n${reg.instructions}`, skillsSection(reg), agentsSection(reg), memorySection(memory, folderMemory)].filter(Boolean).join('\n\n')
}

export function buildSubSystem(reg: Registry, cwd: string, agent: AgentDef | null, canDelegate: boolean): string {
  const role = agent
    ? `You are the "${agent.name}" sub-agent.\n\n${agent.body.trim()}`
    : `You are a general-purpose sub-agent. Complete the task you are given autonomously using your tools.`
  const rules = `# Sub-agent rules\n- You start with no prior conversation; the task prompt is all the context you get.\n- Work autonomously; your FINAL message is returned to the caller verbatim, so make it a complete, self-contained answer.${canDelegate ? '' : '\n- You cannot launch further sub-agents.'}`
  return [role, rules, environment(cwd), reg.instructions && `# User and project instructions\n${reg.instructions}`, skillsSection(reg), canDelegate ? agentsSection(reg) : ''].filter(Boolean).join('\n\n')
}
