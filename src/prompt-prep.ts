import { readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { escape as escapeGlob, glob } from "glob";
import pLimit from "p-limit";

// Linux MAX_ARG_STRLEN = PAGE_SIZE × 32 = 131,072 bytes (~128 KB) caps any single exec arg.
// Prompts larger than this threshold are written to a temp file and referenced via @path
// so the CLI reads from disk, completely bypassing the per-argument kernel limit.
export const LARGE_PROMPT_THRESHOLD = 110 * 1024; // 110 KB — 15% below the ~127 KB measured ceiling

/**
 * Two-phase @file extraction (greedy regex → balanced-delimiter state machine).
 *
 * Phase 1 — GREEDY_AT_RE: captures everything after `@` up to whitespace, `@`,
 * `,`, or `;`. Intentionally over-captures so that paths containing `()` and
 * `[]` (Next.js route groups, dynamic segments, SvelteKit params) are not
 * truncated by the regex.
 *
 * Phase 2 — extractBalancedPath(): walks the captured token tracking `()` and
 * `[]` depth. Unmatched trailing `)` or `]` at depth 0 are stripped as
 * punctuation. Trailing `:!?` are also stripped.
 *
 * Inspired by CommonMark's balanced-parenthesis counting for link destinations
 * (spec §6.7), but extended to handle `[]` and to trim (rather than reject)
 * unmatched trailing closers.
 */
const GREEDY_AT_RE = /(?:^|(?<=\s))@([^\s@,;]+)/g;

/**
 * Characters that signal the token is NOT a file path — used to reject
 * framework template syntax (@click.prevent="save"), shell pipes (@cmd|grep),
 * angle-bracket patterns (@foo<div>), and similar false positives.  (#38)
 *
 * `=` / `"` / `'` → attribute bindings (Vue, Angular, Svelte)
 * `<` / `>`       → HTML/JSX angle brackets
 * `|`             → shell pipes
 * `` ` ``         → template literals / inline code
 */
const NON_PATH_CHARS_RE = /[='"<>|`]/;

/**
 * Strip unmatched trailing `)` / `]` and trailing punctuation from a
 * greedily-captured @file token.
 *
 * For each trailing `)` or `]`, re-scans `raw[0..end)` to check whether it
 * has a matching opener. Unmatched trailing closers and trailing `:!?` are
 * trimmed. Inspired by CommonMark's balanced-parenthesis counting for link
 * destinations (spec §6.7), but extended to handle `[]` and to trim (rather
 * than reject) unmatched trailing closers.
 */
function extractBalancedPath(raw: string): string {
  let end = raw.length;

  // Trim unmatched trailing closers and punctuation from the right
  while (end > 0) {
    const ch = raw[end - 1];
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      let depth = 0;
      for (let i = 0; i < end; i++) {
        if (raw[i] === open) depth++;
        else if (raw[i] === ch) depth--;
      }
      // depth < 0 means more closers than openers — trailing one is unmatched
      if (depth < 0) { end--; continue; }
      break;
    }
    if (".:!?".includes(ch)) { end--; continue; }
    break;
  }

  return raw.slice(0, end);
}

/**
 * Extract @file references from a prompt using the two-phase approach.
 * Returns only tokens whose path contains at least one `/` or `.` — this
 * rejects bare @mentions (e.g. @alice) and most email-like patterns.
 */
function extractFileRefs(text: string): string[] {
  const paths: string[] = [];
  // Reset lastIndex for global regex
  GREEDY_AT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GREEDY_AT_RE.exec(text)) !== null) {
    // Skip tokens containing characters that signal non-file-path context —
    // catches Vue/Angular template syntax (@click.prevent="..."), shell pipes,
    // string delimiters, and similar false positives.  (#38)
    if (NON_PATH_CHARS_RE.test(match[1])) {
      if (process.env.GEMINI_STRUCTURED_LOGS === "1") {
        process.stderr.write(JSON.stringify({
          event: "file_ref_skipped",
          token: match[1].slice(0, 80),
          reason: "non_path_chars",
        }) + "\n");
      }
      continue;
    }
    const balanced = extractBalancedPath(match[1]);
    if (/[/.]/.test(balanced)) {
      paths.push(balanced);
    }
  }
  return paths;
}

/** Count the number of @file tokens in a prompt. */
export function countFileRefs(prompt: string): number {
  return extractFileRefs(prompt).length;
}

/**
 * Escape `[]` in path segments that are not glob wildcards, so that literal
 * directory names like `[slug]` are not interpreted as glob character classes.
 *
 * Splits the path on `/`, and for each segment that does NOT contain `*`, `?`,
 * or `{`, escapes it with `glob.escape()`. Segments that contain wildcards are
 * left untouched so the glob engine can interpret them.
 */
function escapeGlobSegments(rawPath: string): string {
  return rawPath
    .split("/")
    .map((seg) => (/[*?{]/.test(seg) ? seg : escapeGlob(seg)))
    .join("/");
}

/**
 * Expand 2+ @file tokens in a prompt by reading the files and appending a
 * REFERENCE block. Single @file tokens are left untouched so the CLI handles
 * them natively (workspace boundary enforcement, etc.).
 *
 * @tokens in the prompt are masked (@ stripped) after expansion to prevent the
 * Gemini CLI from re-expanding them; file contents are appended in a
 * `[REFERENCE_CONTENT_START] ... [REFERENCE_CONTENT_END]` block and are NOT
 * inlined at the token position.
 *
 * Throws if any referenced file is not found, is a directory, or resolves
 * (following symlinks) to a path outside `cwd`.
 */
export async function expandFileRefs(prompt: string, cwd: string): Promise<string> {
  const fileRefs = extractFileRefs(prompt);
  if (fileRefs.length < 2) return prompt;

  const cwdResolved = nodePath.resolve(cwd);
  let realCwd: string;
  try {
    realCwd = await realpath(cwdResolved);
  } catch (err) {
    throw new Error(`cwd does not exist or is not accessible: ${cwdResolved}`, { cause: err });
  }

  const limit = pLimit(8);
  const sectionGroups = await Promise.all(
    fileRefs.map((rawPath) =>
      limit(async () => {
        let filePaths: string[];
        if (/[*?{]/.test(rawPath)) {
          try {
            filePaths = await glob(escapeGlobSegments(rawPath), {
              cwd: realCwd,
              absolute: true,
              nodir: true,
            });
          } catch (err) {
            throw new Error(
              `Failed to expand glob pattern @${rawPath} in ${realCwd}: ${(err as Error).message}`,
              { cause: err }
            );
          }
          if (filePaths.length === 0) {
            throw new Error(`File not found: @${rawPath} — no files matched in ${realCwd}`);
          }
        } else {
          filePaths = [nodePath.resolve(realCwd, rawPath)];
        }

        return Promise.all(
          filePaths.map(async (absPath) => {
            // realpath() follows symlinks — prevents a symlink inside cwd from escaping the workspace
            let realAbsPath: string;
            try {
              realAbsPath = await realpath(absPath);
            } catch (err) {
              const code = (err as { code?: string }).code;
              const detail = code === "EACCES" ? "permission denied" : "does not exist";
              throw new Error(`File not found: @${rawPath} — ${absPath} ${detail}`, { cause: err });
            }

            const cwdPrefix = realCwd.endsWith(nodePath.sep) ? realCwd : realCwd + nodePath.sep;
            if (!realAbsPath.startsWith(cwdPrefix) && realAbsPath !== realCwd) {
              throw new Error(
                `Path not in workspace: @${rawPath} resolves to ${realAbsPath} which is outside ${realCwd}`
              );
            }

            const readErrorDetails: Record<string, string> = {
              EISDIR: "is a directory — use a glob pattern like @src/**/*.ts",
              EACCES: "permission denied",
            };
            let content: string;
            try {
              content = await readFile(realAbsPath, "utf-8");
            } catch (err) {
              const code = (err as { code?: string }).code ?? "unknown";
              const detail = readErrorDetails[code] ?? `read failed (${code})`;
              throw new Error(`Cannot read @${rawPath} — ${absPath} ${detail}`, { cause: err });
            }

            const relPath = nodePath.relative(realCwd, realAbsPath);
            return `Content from @${relPath}:\n${content}`;
          })
        );
      })
    )
  );
  const sections = sectionGroups.flat();

  // Mask @tokens in the prompt text to prevent double expansion by the CLI
  // We use a replacement function with the same regex to ensure consistency.
  GREEDY_AT_RE.lastIndex = 0;
  const maskedPrompt = prompt.replace(GREEDY_AT_RE, (match, pathToken) => {
    // Apply the same non-path filter as extractFileRefs — without this,
    // framework tokens like @click.prevent="save" get their @ stripped.  (#38)
    if (NON_PATH_CHARS_RE.test(pathToken)) return match;
    const balanced = extractBalancedPath(pathToken);
    if (/[/.]/.test(balanced)) {
      // Replace the matched token (including @) with just the balanced path.
      // We keep the rest of the original token if any (punctuation that was trimmed).
      return match.replace(`@${balanced}`, balanced);
    }
    return match;
  });

  // Sentinel delimiters give the model a clear boundary for injected content.
  // The "Content from @<relPath>:" header preserves the original @token reference.
  const referenceBlock = `\n\n[REFERENCE_CONTENT_START]\n${sections.join("\n\n")}\n[REFERENCE_CONTENT_END]`;
  return maskedPrompt + referenceBlock;
}
