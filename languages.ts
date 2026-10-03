import { createRequire } from "node:module";
import { join } from "node:path";
import { getLanguageFromPath, getPackageDir } from "@earendil-works/pi-coding-agent";

interface Grammar { aliases?: string[] }
interface Registry { listLanguages(): string[]; getLanguage(name: string): Grammar | undefined }
export interface LanguageChoice { value: string; label: string; description?: string }
let catalog: LanguageChoice[] | undefined;
let registry: Registry | undefined;
let catalogError: string | undefined;
const names = new Map<string, string>();

/** Resolve Pi's existing dependency, not a project dependency or a second highlighter install. */
export function languageCatalog(): readonly LanguageChoice[] {
  if (catalog) return catalog;
  try {
    const require = createRequire(join(getPackageDir(), "package.json"));
    // Pi's syntax-highlight.js imports highlight.js/lib/core from its own package dependency.
    // Loading that dependency's full index registers all shipped grammars on the same core.
    registry = require("highlight.js") as Registry;
    const languages = registry.listLanguages().sort();
    for (const name of languages) names.set(name.toLowerCase(), name);
    catalog = languages.map((name) => {
      const aliases = registry!.getLanguage(name)?.aliases ?? [];
      for (const alias of aliases) if (!names.has(alias.toLowerCase())) names.set(alias.toLowerCase(), name);
      return { value: name, label: name, description: aliases.join(", ") || undefined };
    });
  } catch (error) {
    registry = undefined;
    names.clear();
    catalog = [];
    catalogError = error instanceof Error ? error.message : String(error);
  }
  return catalog;
}

export function languageCatalogError(): string | undefined { languageCatalog(); return catalogError; }
export function resolveLanguage(name: string): string | undefined {
  languageCatalog();
  return names.get(name.toLowerCase());
}

/** Known file names, Pi mappings, then grammar names/aliases as extensions. Never inspect disk. */
export function languageFromPath(path: string): string | undefined {
  languageCatalog();
  const file = path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  const special = /^dockerfile(?:\..+)?$/.test(file) ? "dockerfile"
    : /^(?:gnumakefile|makefile)(?:\..+)?$/.test(file) ? "makefile"
      : file === "cmakelists.txt" ? "cmake"
        : /^(?:\.(?:bashrc|zshrc|profile|bash_profile))$/.test(file) ? "bash"
          : /^(?:\.(?:gitconfig|editorconfig|npmrc|env))(?:\..+)?$/.test(file) ? "ini" : undefined;
  const extra: Record<string, string> = {
    cts: "typescript", mts: "typescript", jsonc: "json", vue: "xml", svelte: "xml",
    hxx: "cpp", hh: "cpp", ipp: "cpp", cc: "cpp", cxx: "cpp",
    fsx: "fsharp", fsi: "fsharp", jl: "julia", pl: "perl", pm: "perl", exs: "elixir",
    erl: "erlang", hrl: "erlang", lhs: "haskell", mli: "ocaml", el: "lisp", scm: "scheme",
    tex: "latex", sty: "latex", cls: "latex", v: "verilog", sv: "verilog", svh: "verilog",
    vhd: "vhdl", vhdl: "vhdl", asm: "x86asm",
  };
  const ext = file.includes(".") ? file.split(".").at(-1)! : "";
  const hint = special ?? getLanguageFromPath(path) ?? extra[ext];
  // If the dependency cannot be resolved (e.g. a standalone binary), keep Pi's own hint path.
  return registry ? resolveLanguage(hint ?? ext) : hint;
}

/** Explicit interpreter names only; arbitrary executable names are not language evidence. */
export function interpreterLanguage(executable: string): string | undefined {
  const name = executable.replace(/.*[\\/]/, "");
  const interpreter = /^python(?:\d+(?:\.\d+)*)?$/.test(name) ? "python"
    : /^(?:node|nodejs)$/.test(name) ? "javascript"
      : /^(?:bash|sh|zsh)$/.test(name) ? "bash"
        : /^(?:pwsh|powershell)$/.test(name) ? "powershell"
          : /^(?:R|Rscript)$/.test(name) ? "r"
            : ["ruby", "perl", "php", "lua", "julia", "groovy", "elixir", "swift"].includes(name) ? name : undefined;
  return interpreter ? resolveLanguage(interpreter) ?? interpreter : undefined;
}

export function shebangLanguage(text: string): string | undefined {
  const match = /^#!\s*(?:\S*\/env\s+(?:-S\s+)?)?(\S+)/.exec(text);
  return match ? interpreterLanguage(match[1]) : undefined;
}
