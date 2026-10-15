import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads Agent Skills (skills/<name>/SKILL.md + reference/*.md) so the same reviewed
 * instructions drive Claude Code and the production agents.
 *
 * Frontmatter rules (Agent Skills docs, verified 2026-10-15):
 *  - name: required, ≤ 64 chars, lowercase letters/digits/hyphens, no XML tags,
 *          must not contain "anthropic" or "claude"
 *  - description: required, non-empty, ≤ 1024 chars, no XML tags
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  references: Array<{ file: string; content: string }>;
}

export class SkillFormatError extends Error {
  override name = "SkillFormatError";
}

export function parseSkillMd(source: string, file = "SKILL.md"): Omit<Skill, "references"> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new SkillFormatError(`${file}: missing YAML frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new SkillFormatError(`${file}: unsupported frontmatter line "${line}" (only single-line key: value pairs)`);
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[kv[1]!] = v;
  }
  const name = fm.name ?? "";
  const description = fm.description ?? "";
  if (!name) throw new SkillFormatError(`${file}: name is required`);
  if (name.length > 64) throw new SkillFormatError(`${file}: name exceeds 64 characters`);
  if (!/^[a-z0-9-]+$/.test(name)) throw new SkillFormatError(`${file}: name must use lowercase letters, digits and hyphens`);
  if (/anthropic|claude/.test(name)) throw new SkillFormatError(`${file}: name must not contain "anthropic" or "claude"`);
  if (!description) throw new SkillFormatError(`${file}: description is required`);
  if (description.length > 1024) throw new SkillFormatError(`${file}: description exceeds 1024 characters`);
  if (/<[^>]+>/.test(name + description)) throw new SkillFormatError(`${file}: XML tags are not allowed in name or description`);
  return { name, description, body: m[2]!.trim() };
}

export async function loadSkill(skillsRoot: string, name: string): Promise<Skill> {
  const dir = join(skillsRoot, name);
  const parsed = parseSkillMd(await readFile(join(dir, "SKILL.md"), "utf8"), `${name}/SKILL.md`);
  if (parsed.name !== name) throw new SkillFormatError(`${name}/SKILL.md: frontmatter name "${parsed.name}" must match its folder`);
  const references: Skill["references"] = [];
  try {
    for (const f of (await readdir(join(dir, "reference"))).filter((f) => f.endsWith(".md")).sort()) {
      references.push({ file: `reference/${f}`, content: (await readFile(join(dir, "reference", f), "utf8")).trim() });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { ...parsed, references };
}

export async function listSkills(skillsRoot: string): Promise<string[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** System prompt text for an agent: skill body followed by its reference files. */
export function skillInstructions(skill: Skill): string {
  const refs = skill.references.map((r) => `<reference file="${r.file}">\n${r.content}\n</reference>`).join("\n\n");
  return [`# Skill: ${skill.name}`, skill.body, refs].filter(Boolean).join("\n\n");
}

/** Default location of the repo's skills folder. */
export const REPO_SKILLS_ROOT = fileURLToPath(new URL("../../../skills/", import.meta.url));
